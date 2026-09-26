import { OAuth2Client } from 'google-auth-library';

export interface InternalIdentityVerifier {
  verify(token: string): Promise<boolean>;
}

/** The public MCP service must verify internal callers itself; Cloud Run IAM is service-wide. */
export class GoogleServiceAccountVerifier implements InternalIdentityVerifier {
  constructor(private readonly audience: string, private readonly serviceAccount: string,
    private readonly client: Pick<OAuth2Client, 'verifyIdToken'> = new OAuth2Client()) {}

  async verify(token: string): Promise<boolean> {
    try {
      const ticket = await this.client.verifyIdToken({ idToken: token, audience: this.audience });
      const payload = ticket.getPayload();
      return !!payload && (payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com') &&
        payload.aud === this.audience && payload.email_verified === true &&
        payload.email?.toLowerCase() === this.serviceAccount.toLowerCase();
    } catch { return false; }
  }
}
