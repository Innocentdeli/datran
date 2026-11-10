import { NextResponse } from 'next/server';

export async function GET() {
  const securityTxt = [
    '# Datran Coordinated Vulnerability Disclosure & Security Policy',
    '# Reference: RFC 9116',
    'Contact: mailto:security@datran.io',
    'Expires: 2027-12-31T23:59:59.000Z',
    'Preferred-Languages: en',
    'Canonical: https://datran.io/.well-known/security.txt',
    'Policy: https://datran.io/security',
    'Acknowledgments: https://datran.io/security#hall-of-fame',
    'Encryption: https://datran.io/pgp-key.asc'
  ].join('\n');

  return new NextResponse(securityTxt, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
