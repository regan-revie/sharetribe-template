process.env.NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID || 'test-client-id';
process.env.NYLAS_API_KEY = process.env.NYLAS_API_KEY || 'test-api-key';
process.env.NYLAS_API_BASE_URL = 'https://api.us.nylas.com';

const { buildAuthUrl } = require('./client');

const REDIRECT = 'https://revie.example.com/api/nylas/callback';

const paramsOf = url => new URL(url).searchParams;

describe('buildAuthUrl()', () => {
  it('points at the configured region host and the auth endpoint', () => {
    const url = new URL(buildAuthUrl({ redirectUri: REDIRECT, state: 's' }));
    expect(url.host).toBe('api.us.nylas.com');
    expect(url.pathname).toBe('/v3/connect/auth');
  });

  it('requests an authorization code with offline access', () => {
    const p = paramsOf(buildAuthUrl({ redirectUri: REDIRECT, state: 's' }));
    expect(p.get('response_type')).toBe('code');
    // Without offline access Nylas keeps no refresh token and the coach's calendar silently
    // disconnects once the access token expires.
    expect(p.get('access_type')).toBe('offline');
  });

  it('passes through redirect_uri and state unchanged', () => {
    const p = paramsOf(buildAuthUrl({ redirectUri: REDIRECT, state: 'opaque-state' }));
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('state')).toBe('opaque-state');
  });

  it('includes provider when given, so Nylas skips its provider-picker screen', () => {
    const p = paramsOf(buildAuthUrl({ redirectUri: REDIRECT, state: 's', provider: 'google' }));
    expect(p.get('provider')).toBe('google');
  });

  it('omits provider, login_hint and scope when not given', () => {
    const p = paramsOf(buildAuthUrl({ redirectUri: REDIRECT, state: 's' }));
    expect(p.has('provider')).toBe(false);
    expect(p.has('login_hint')).toBe(false);
    expect(p.has('scope')).toBe(false);
  });

  it('space-joins scopes, as the OAuth spec requires', () => {
    const p = paramsOf(
      buildAuthUrl({
        redirectUri: REDIRECT,
        state: 's',
        scope: ['openid', 'https://www.googleapis.com/auth/calendar.events'],
      })
    );
    expect(p.get('scope')).toBe('openid https://www.googleapis.com/auth/calendar.events');
  });

  it('never leaks the API key into the redirect URL', () => {
    // The auth URL goes to the browser, so only the client id may appear in it.
    const url = buildAuthUrl({ redirectUri: REDIRECT, state: 's', provider: 'google' });
    expect(url).not.toContain(process.env.NYLAS_API_KEY);
  });
});
