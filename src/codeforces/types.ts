export interface Contest {
  id: number;
  name: string;
  type: string;
  phase: string;
  frozen: boolean;
  durationSeconds: number;
  startTimeSeconds?: number;
  relativeTimeSeconds?: number;
}

export interface CodeforcesUser {
  handle: string;
  rating?: number;
  maxRating?: number;
  rank?: string;
  maxRank?: string;
}

export interface Problem {
  contestId?: number;
  index: string;
  name: string;
  type: string;
  points?: number;
  rating?: number;
  tags: string[];
}

export interface Submission {
  id: number;
  contestId?: number;
  problem: Problem;
  programmingLanguage: string;
  verdict?: string;
  passedTestCount: number;
  timeConsumedMillis: number;
  memoryConsumedBytes: number;
  author?: { members?: Array<{ handle: string }> };
}

export interface RatingChange {
  contestId: number;
  contestName: string;
  handle: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
}

export interface ProblemStatement {
  contestId: number;
  index: string;
  name: string;
  timeLimit: string;
  memoryLimit: string;
  statement: string;
  input: string;
  output: string;
  examples: Array<{ input: string; output: string }>;
  note: string;
}
