/** The minimum request understood by the registry's history-seeding boundary. */
export interface HistorySeedRequest {
  childSessionFile: string;
}

export interface HistorySeedResult {
  kind: "fresh";
  seededParentMessages: 0;
}

export interface HistorySeeder {
  seed(request: HistorySeedRequest): Promise<HistorySeedResult>;
}

const FRESH_HISTORY_RESULT: HistorySeedResult = Object.freeze({
  kind: "fresh",
  seededParentMessages: 0,
});

/**
 * Sprint 1 deliberately gives every child fresh conversational history.
 * Session-path allocation has already created an empty JSONL; this seeder must
 * not inspect the parent session or write anything before Pi opens that file.
 */
export class FreshHistorySeeder implements HistorySeeder {
  async seed(request: HistorySeedRequest): Promise<HistorySeedResult> {
    void request;
    return FRESH_HISTORY_RESULT;
  }
}

export const freshHistorySeeder: HistorySeeder = new FreshHistorySeeder();
