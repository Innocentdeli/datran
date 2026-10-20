import { readFileSync } from 'node:fs';
import { test, expect, fixtureFile, uploadViaLanding, openAsRecipient, appAlerts } from '../fixtures';

// e2e/fixtures/clip.mp4: 8 s, 320x180, VP9 in MP4 (~135 KB), self-generated with ffmpeg's testsrc2 (no third-party
// content). VP9 so it also plays in Playwright's bundled Chromium, which has no proprietary codecs (H.264).
//   ffmpeg -f lavfi -i testsrc2=size=320x180:rate=15 -t 8 -c:v libvpx-vp9 -b:v 150k -pix_fmt yuv420p -g 15 \
//          -movflags +faststart clip.mp4

test('encrypted video previews and seeks through the service worker (Range)', async ({ page, newRecipientContext }) => {
    const file = await fixtureFile('clip.mp4');
    const original = readFileSync(file.path);
    const link = await uploadViaLanding(page, [file]);

    const { page: viewer } = await openAsRecipient(newRecipientContext, link);
    const swResponses: Array<{ url: string; status: number; fromSW: boolean }> = [];
    viewer.on('response', (r) => {
        if (new URL(r.url()).pathname.startsWith('/v1/e2e/')) swResponses.push({ url: r.url(), status: r.status(), fromSW: r.fromServiceWorker() });
    });

    const video = viewer.locator('video');
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', /^\/v1\/e2e\//); // streamed by the decrypting worker, not a Blob
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const duration = await video.evaluate((v: HTMLVideoElement) => v.duration);
    expect(duration).toBeGreaterThan(7);

    // The worker answers byte ranges of the decrypted file exactly.
    const range = await video.evaluate(async (v: HTMLVideoElement) => {
        const res = await fetch(v.currentSrc, { headers: { Range: 'bytes=1000-4999' } });
        return { status: res.status, contentRange: res.headers.get('content-range'), bytes: Array.from(new Uint8Array(await res.arrayBuffer())) };
    });
    expect(range.status).toBe(206);
    expect(range.contentRange).toBe(`bytes 1000-4999/${file.size}`);
    expect(Buffer.from(range.bytes).equals(original.subarray(1000, 5000))).toBe(true);

    // Seek near the end: the element seeks and can play from there.
    const seeked = await video.evaluate(async (v: HTMLVideoElement) => {
        const target = v.duration * 0.8;
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('seek timed out')), 20_000);
            v.addEventListener('seeked', () => { clearTimeout(t); resolve(); }, { once: true });
            v.currentTime = target;
        });
        return { currentTime: v.currentTime, target, error: v.error?.code ?? null };
    });
    expect(seeked.error).toBeNull();
    expect(Math.abs(seeked.currentTime - seeked.target)).toBeLessThan(1);
    await expect(appAlerts(viewer)).toHaveCount(0);

    // Media requests went to the worker's virtual URL and were answered with partial content.
    expect(swResponses.some((r) => r.fromSW && r.status === 206)).toBe(true);
});
