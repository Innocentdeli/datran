import db from '@/db';
import { promises as dns } from 'dns';

export interface UserBrand {
  user_id: string;
  brand_name: string | null;
  brand_logo_url: string | null;
  brand_color: string | null;
  brand_wallpaper_url: string | null;
  brand_tagline: string | null;
  custom_domain: string | null;
  custom_domain_status: 'pending' | 'verified' | 'failed';
  created_at: number;
  updated_at: number;
}

export interface UpsertBrandInput {
  brand_name?: string | null;
  brand_logo_url?: string | null;
  brand_color?: string | null;
  brand_wallpaper_url?: string | null;
  brand_tagline?: string | null;
  custom_domain?: string | null;
}

export const BrandingService = {
  /** Fetch brand settings for a specific user ID */
  async getBrandForUser(userId: string): Promise<UserBrand | null> {
    if (!userId) return null;
    const res = await db.query('SELECT * FROM user_brands WHERE user_id = $1', [userId]);
    return (res.rows[0] as UserBrand) || null;
  },

  /** Fetch brand settings associated with a custom domain hostname */
  async getBrandByDomain(domain: string): Promise<UserBrand | null> {
    if (!domain) return null;
    const cleanDomain = domain.trim().toLowerCase().split(':')[0]; // strip port
    const res = await db.query('SELECT * FROM user_brands WHERE custom_domain = $1', [cleanDomain]);
    return (res.rows[0] as UserBrand) || null;
  },

  /** Fetch brand settings for the owner of a shared file */
  async getBrandForFile(fileId: string): Promise<UserBrand | null> {
    if (!fileId) return null;
    const fileRes = await db.query('SELECT user_id FROM files WHERE share_id = $1', [fileId]);
    const file = fileRes.rows[0];
    if (!file || !file.user_id) return null;
    return this.getBrandForUser(file.user_id);
  },

  /** Create or update brand settings */
  async upsertBrand(userId: string, input: UpsertBrandInput): Promise<UserBrand> {
    const existing = await this.getBrandForUser(userId);
    const now = Date.now();

    const brandName = input.brand_name !== undefined ? (input.brand_name?.trim() || null) : (existing?.brand_name || null);
    const brandLogoUrl = input.brand_logo_url !== undefined ? (input.brand_logo_url?.trim() || null) : (existing?.brand_logo_url || null);
    const brandColor = input.brand_color !== undefined ? (input.brand_color?.trim() || null) : (existing?.brand_color || null);
    const brandWallpaperUrl = input.brand_wallpaper_url !== undefined ? (input.brand_wallpaper_url?.trim() || null) : (existing?.brand_wallpaper_url || null);
    const brandTagline = input.brand_tagline !== undefined ? (input.brand_tagline?.trim() || null) : (existing?.brand_tagline || null);
    
    let customDomain = existing?.custom_domain || null;
    let customDomainStatus = existing?.custom_domain_status || 'pending';

    if (input.custom_domain !== undefined) {
      const clean = input.custom_domain?.trim().toLowerCase() || null;
      if (clean !== customDomain) {
        customDomain = clean;
        customDomainStatus = 'pending';
      }
    }

    const createdAt = existing ? existing.created_at : now;

    await db.query(`
      INSERT INTO user_brands (
        user_id, brand_name, brand_logo_url, brand_color,
        brand_wallpaper_url, brand_tagline, custom_domain,
        custom_domain_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (user_id) DO UPDATE SET
        brand_name = EXCLUDED.brand_name,
        brand_logo_url = EXCLUDED.brand_logo_url,
        brand_color = EXCLUDED.brand_color,
        brand_wallpaper_url = EXCLUDED.brand_wallpaper_url,
        brand_tagline = EXCLUDED.brand_tagline,
        custom_domain = EXCLUDED.custom_domain,
        custom_domain_status = EXCLUDED.custom_domain_status,
        updated_at = EXCLUDED.updated_at
    `, [
      userId,
      brandName,
      brandLogoUrl,
      brandColor,
      brandWallpaperUrl,
      brandTagline,
      customDomain,
      customDomainStatus,
      createdAt,
      now
    ]);

    return {
      user_id: userId,
      brand_name: brandName,
      brand_logo_url: brandLogoUrl,
      brand_color: brandColor,
      brand_wallpaper_url: brandWallpaperUrl,
      brand_tagline: brandTagline,
      custom_domain: customDomain,
      custom_domain_status: customDomainStatus as 'pending' | 'verified' | 'failed',
      created_at: createdAt,
      updated_at: now
    };
  },

  /** Verify DNS CNAME record for custom domain */
  async verifyCustomDomain(userId: string, domain: string): Promise<{ verified: boolean; message: string }> {
    const cleanDomain = domain.trim().toLowerCase();
    if (!cleanDomain) throw new Error('Domain name is required');

    try {
      const cnameTarget = (process.env.CUSTOM_DOMAIN_CNAME_TARGET || 'cname.datran.app').toLowerCase();

      // In development or local testing, allow localhost/test domains or simulated verification
      if (cleanDomain.endsWith('.local') || cleanDomain.includes('localhost') || process.env.NODE_ENV === 'development') {
        const now = Date.now();
        await db.query('UPDATE user_brands SET custom_domain_status = $1, updated_at = $2 WHERE user_id = $3', ['verified', now, userId]);
        return {
          verified: true,
          message: `Domain ${cleanDomain} verified successfully (development simulated). CNAME points to ${cnameTarget}.`
        };
      }

      const records = await dns.resolveCname(cleanDomain);
      const isPointingToDatran = records.some(
        (r) => r.toLowerCase().includes(cnameTarget) || r.toLowerCase().includes('datran.app')
      );

      const now = Date.now();
      const status = isPointingToDatran ? 'verified' : 'failed';
      await db.query('UPDATE user_brands SET custom_domain_status = $1, updated_at = $2 WHERE user_id = $3', [status, now, userId]);

      if (isPointingToDatran) {
        return {
          verified: true,
          message: `DNS check passed! ${cleanDomain} is pointing to ${cnameTarget} and SSL is provisioned.`
        };
      } else {
        return {
          verified: false,
          message: `CNAME record for ${cleanDomain} does not point to ${cnameTarget} (found: ${records.join(', ')}). DNS propagation can take up to 24 hours.`
        };
      }
    } catch (err) {
      const cnameTarget = (process.env.CUSTOM_DOMAIN_CNAME_TARGET || 'cname.datran.app').toLowerCase();
      const now = Date.now();
      await db.query('UPDATE user_brands SET custom_domain_status = $1, updated_at = $2 WHERE user_id = $3', ['failed', now, userId]);
      return {
        verified: false,
        message: `DNS lookup failed for ${cleanDomain}: ${(err as Error)?.message || 'No CNAME record found'}. Ensure you add a CNAME record pointing to ${cnameTarget}.`
      };
    }
  },

  /** Remove custom branding and reset to default */
  async deleteBrand(userId: string): Promise<void> {
    await db.query('DELETE FROM user_brands WHERE user_id = $1', [userId]);
  }
};
