import { google, sheets_v4 } from 'googleapis';

export interface SheetMeta {
  sheets?: { properties?: { title?: string } }[];
}

/** True if a tab with the given title exists in the spreadsheet metadata. */
export function tabExists(meta: SheetMeta, tab: string): boolean {
  return (meta.sheets ?? []).some((s) => s.properties?.title === tab);
}

/** Shape the A1 range + values grid for one tab (header row + symbols). */
export function valuesPayload(tab: string, symbols: string[]): { range: string; values: string[][] } {
  return { range: `'${tab}'!A1`, values: [['Symbol'], ...symbols.map((s) => [s])] };
}

function credsPath(): string {
  const p = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!p) {
    throw new Error(
      'GOOGLE_SHEETS_CREDENTIALS is not set — point it at the service-account JSON key file.'
    );
  }
  return p;
}

async function client(): Promise<sheets_v4.Sheets> {
  const auth = new google.auth.GoogleAuth({
    keyFile: credsPath(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: (await auth.getClient()) as never });
}

/** Overwrite one tab's column A with `symbols` (header + rows). Creates the tab if missing. */
export async function writeTab(spreadsheetId: string, tab: string, symbols: string[]): Promise<void> {
  const api = await client();
  const meta = (await api.spreadsheets.get({ spreadsheetId })).data as SheetMeta;
  if (!tabExists(meta, tab)) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
  }
  await api.spreadsheets.values.clear({ spreadsheetId, range: `'${tab}'!A:A` });
  const { range, values } = valuesPayload(tab, symbols);
  await api.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}
