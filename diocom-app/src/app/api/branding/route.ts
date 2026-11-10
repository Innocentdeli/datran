import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { BrandingService } from '@/lib/branding/service';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const brand = await BrandingService.getBrandForUser(session.user.id);
    return NextResponse.json({ brand });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to fetch brand settings' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const brand = await BrandingService.upsertBrand(session.user.id, {
      brand_name: body.brand_name,
      brand_logo_url: body.brand_logo_url,
      brand_color: body.brand_color,
      brand_wallpaper_url: body.brand_wallpaper_url,
      brand_tagline: body.brand_tagline,
      custom_domain: body.custom_domain,
    });

    return NextResponse.json({ success: true, brand });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to update brand settings' }, { status: 500 });
  }
}

export async function DELETE() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await BrandingService.deleteBrand(session.user.id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to reset brand settings' }, { status: 500 });
  }
}
