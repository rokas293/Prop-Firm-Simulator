// The journal entry of a trade that is open (FXR_V2_SPEC.md 3.5, Save & Journal):
// a trade is only journaled when its first exit lands, so until then the entry
// is the position itself. Notes and tags written here ride on the position and
// land on the trade at that exit.
export const OPEN_ENTRY_ID = -1

export interface OpenJournalEntry {
  tradeKey: string
  instrument: string
  side: 'long' | 'short'
  contracts: number
  entryTime: number
  entryPrice: number
  slPrice: number | null
  tpPrice: number | null
  tags: string[]
  // The checklist rules ticked in the Place Order dialog.
  checklist: string[]
  notes: string
}
