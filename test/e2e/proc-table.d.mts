// Only the surface unit tests import; the module is plain JS.
export interface StatRow {
  pid: number;
  ppid: number;
  comm: string;
}
export interface ProcRow extends StatRow {
  cmdline: string | null;
}
export function parseStat(text: string): StatRow | null;
export function readProcTable(io?: {
  readdir?: (path: string) => string[];
  readFile?: (path: string, encoding: 'utf8') => string;
}): ProcRow[];
export function descendantsOf(rootPid: number, table: { pid: number; ppid: number }[]): number[];
export function findByCmdline(table: ProcRow[], needles: string[]): ProcRow[];
export function killTree(
  rootPid: number,
  o?: {
    readTable?: () => { pid: number; ppid: number }[];
    kill?: (pid: number) => void;
  },
): number[];
