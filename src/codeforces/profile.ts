import type { CodeforcesApi } from './api.js';
import { CodeforcesError } from './errors.js';

export interface AccountProfile {
  handle: string;
  rating: number | null;
  maxRating: number | null;
  rank: string | null;
  maxRank: string | null;
}

export class AccountProfileService {
  constructor(private readonly api: Pick<CodeforcesApi, 'userInfo'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly knownHandle?: () => string | undefined) {}

  async getAccountProfile(): Promise<AccountProfile> {
    const configured = [this.env.CF_EXPECTED_HANDLE?.trim(), this.env.CF_HANDLE?.trim()].filter((value): value is string => !!value);
    if (configured.length === 2 && configured[0]!.toLowerCase() !== configured[1]!.toLowerCase())
      throw new CodeforcesError('CF_EXPECTED_HANDLE and CF_HANDLE disagree.', 'ACCOUNT_MISMATCH');
    const handle = configured[0] ?? this.knownHandle?.();
    if (!handle || !/^[\w.-]{1,50}$/.test(handle))
      throw new CodeforcesError('Configure a valid CF_EXPECTED_HANDLE or CF_HANDLE.', 'CF_AUTH_REQUIRED');
    const user = await this.api.userInfo(handle);
    if (user.handle.toLowerCase() !== handle.toLowerCase())
      throw new CodeforcesError('Official account profile did not match the configured handle.', 'ACCOUNT_MISMATCH');
    const rating = Number.isSafeInteger(user.rating) ? user.rating! : null;
    const maxRating = Number.isSafeInteger(user.maxRating) ? user.maxRating! : null;
    return { handle: user.handle, rating, maxRating,
      rank: typeof user.rank === 'string' ? user.rank : null,
      maxRank: typeof user.maxRank === 'string' ? user.maxRank : null };
  }
}
