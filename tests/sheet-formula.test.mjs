import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const { evaluateFormula } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/sheet-formula.ts')));

const serial = (y, m, d) => Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
const D = { jan15: serial(2024, 1, 15), feb15: serial(2024, 2, 15), mar15: serial(2024, 3, 15), jan31: serial(2024, 1, 31) };
// Sheet S: a small sales table (A:D, rows 1-6; A6 is blank). Sheet T: sorted lookup keys.
const sheets = {
  S: [['Region', 'Units', 'Price', 'Date'], ['North', 10, 2.5, D.jan15], ['South', 20, 3, D.feb15], ['north', 5, 4, D.mar15], ['East', 15, 1.5, null], [null, null, null, null]],
  T: [[1, 'low', 'x'], [5, 'mid', 'y'], [10, 'high', 'z']],
};
const lookup = (sheet, col, row) => sheets[sheet ?? 'S']?.[row - 1]?.[col - 1] ?? null;
const extent = (sheet) => sheets[sheet ?? 'S'] ? { rows: sheets[sheet ?? 'S'].length, cols: 4 } : undefined;
const calc = (formula) => evaluateFormula(formula, lookup, 'S', 0, extent);
const value = (formula) => { const result = calc(formula); assert.ok(result.ok, `${formula} -> ${JSON.stringify(result)}`); return result.value; };
const error = (formula) => { const result = calc(formula); assert.equal(result.ok, false, `${formula} should fail`); assert.ok(!result.unsupported, `${formula} is unsupported, expected an error`); return result.error; };
const unsupported = (formula) => assert.equal(calc(formula).unsupported, true, `${formula} should be left to the application`);
const table = (cases) => { for (const [formula, expected] of cases) assert.deepEqual(value(formula), expected, formula); };

test('criteria functions follow spreadsheet rules: case-insensitive text, operators, wildcards, blanks', () => {
  table([
    ['=SUMIF(A2:A5,"North",B2:B5)', 15], ['=SUMIF(B2:B5,">9")', 45], ['=SUMIF(A2:A5,"n*",B2:B5)', 15], ['=SUMIF(A2:A5,"<>North",B2:B5)', 35], ['=SUMIF(A2:A5,"?outh",B2:B5)', 20],
    ['=SUMIF(A2:A5,"North")', 0], ['=COUNTIF(A2:A5,"North")', 2], ['=COUNTIF(B2:B5,">=15")', 2], ['=COUNTIF(A2:A6,"")', 1], ['=COUNTIF(A2:A6,"<>")', 4], ['=COUNTIF(B2:B5,10)', 1], ['=COUNTIF(B2:B5,"10")', 1],
    ['=SUMIFS(B2:B5,A2:A5,"north",C2:C5,">3")', 5], ['=COUNTIFS(A2:A5,"north",B2:B5,">7")', 1], ['=AVERAGEIF(A2:A5,"north",B2:B5)', 7.5], ['=AVERAGEIFS(B2:B5,B2:B5,">5")', 15],
    ['=MAXIFS(B2:B5,A2:A5,"north")', 10], ['=MINIFS(B2:B5,A2:A5,"north")', 5], ['=MAXIFS(B2:B5,A2:A5,"nobody")', 0], ['=SUMPRODUCT(B2:B5,C2:C5)', 127.5],
    ['=SUMIF(B2:B5,">"&5,C2:C5)', 7], ['=COUNTIF(D2:D5,">"&DATE(2024,2,1))', 2],
  ]);
  assert.equal(error('=AVERAGEIF(A2:A5,"nobody",B2:B5)'), '#DIV/0!'); assert.equal(error('=SUMIFS(B2:B5,A2:A4,"x")'), '#VALUE!');
});

test('math, rounding and statistics match spreadsheet results, including the classic floating point cases', () => {
  table([
    ['=MEDIAN(B2:B5)', 12.5], ['=VAR.S(B2:B5)', 41.666666666666664], ['=VAR(B2:B5)', 41.666666666666664], ['=VAR.P(B2:B5)', 31.25], ['=STDEV.P(B2:B5)', Math.sqrt(31.25)], ['=LARGE(B2:B5,2)', 15], ['=SMALL(B2:B5,1)', 5], ['=COUNTBLANK(A2:A6)', 1], ['=PRODUCT(B2:B3)', 200], ['=SIGN(-3)', -1], ['=PI()', Math.PI],
    ['=INT(-2.5)', -3], ['=MOD(-3,2)', 1], ['=MOD(3,-2)', -1], ['=POWER(2,10)', 1024], ['=SQRT(16)', 4], ['=ROUND(2.675,2)', 2.68], ['=ROUND(1234.5678,-2)', 1200], ['=ROUND(-2.5,0)', -3],
    ['=ROUNDUP(2.341,2)', 2.35], ['=ROUNDDOWN(-2.349,2)', -2.34], ['=ROUNDUP(1.1,0)', 2], ['=CEILING(2.1,0.5)', 2.5], ['=FLOOR(2.7,0.5)', 2.5], ['=SUM(B2:B5)/COUNT(B2:B5)', 12.5], ['=0.1+0.2&""', '0.3'], ['=1/3&""', '0.333333333333333'],
    ['=SUM(A2,B2)', 10], ['=COUNT(A2,B2)', 1], ['=AVERAGE(B2,B3,C2)', (10 + 20 + 2.5) / 3],
  ]);
  assert.equal(error('=STDEV.S(B2)'), '#DIV/0!'); assert.ok(Math.abs(value('=STDEV.S(B2:B5)') - Math.sqrt(41.666666666666664)) < 1e-12); assert.equal(error('=SQRT(-1)'), '#NUM!'); assert.equal(error('=POWER(0,-1)'), '#DIV/0!'); assert.equal(error('=MOD(1,0)'), '#DIV/0!'); assert.equal(error('=MEDIAN(A2:A3)'), '#NUM!'); assert.equal(error('=LARGE(B2:B5,9)'), '#NUM!');
});

test('logic: lazy branches, IFS, SWITCH, CHOOSE, error trapping and Excel comparison rules', () => {
  table([
    ['=IFS(B2>50,"a",B2>5,"b",TRUE,"c")', 'b'], ['=SWITCH(B2,10,"ten",20,"twenty","other")', 'ten'], ['=SWITCH(99,10,"ten","other")', 'other'], ['=CHOOSE(2,"a","b","c")', 'b'], ['=CHOOSE(2,1/0,"b")', 'b'],
    ['=IFNA(VLOOKUP("zzz",A2:C5,2,FALSE),"none")', 'none'], ['=IFERROR(VLOOKUP("zzz",A2:C5,2,FALSE),0)', 0], ['=ISERROR(1/0)', true], ['=ISERROR(5)', false], ['=ISBLANK(A6)', true], ['=ISBLANK(A2)', false], ['=ISNUMBER(B2)', true], ['=ISTEXT(A2)', true],
    ['=IF(A6="","blank","filled")', 'blank'], ['=A6=0', true], ['=B2>"a"', false], ['="a"<"B"', true], ['="a"="A"', true], ['=IF(AND(B2>5,C2<3),"yes","no")', 'yes'], ['=OR(B2>50,C2>50)', false], ['=NOT(B2>50)', true], ['=IF(B2>5,"big")', 'big'], ['=IF(B2>50,"big")', false],
  ]);
  assert.equal(error('=IFS(B2>50,"a")'), '#N/A'); assert.equal(error('=SWITCH(1,2,"x")'), '#N/A'); assert.equal(error('=CHOOSE(5,"a")'), '#VALUE!'); assert.equal(error('=IFNA(1/0,1)'), '#DIV/0!');
});

test('text functions and TEXT formats', () => {
  table([
    ['=LEFT("Hello",2)', 'He'], ['=LEFT("Hello")', 'H'], ['=RIGHT("Hello",3)', 'llo'], ['=MID("Hello",2,3)', 'ell'], ['=UPPER("aB")', 'AB'], ['=LOWER("aB")', 'ab'], ['=PROPER("hello wORLD 2nd")', 'Hello World 2Nd'], ['=TRIM("  a   b ")', 'a b'],
    ['=SUBSTITUTE("a-b-c","-","+")', 'a+b+c'], ['=SUBSTITUTE("a-b-c","-","+",2)', 'a-b+c'], ['=REPT("ab",3)', 'ababab'], ['=FIND("l","Hello")', 3], ['=SEARCH("L","Hello")', 3], ['=FIND("l","Hello",4)', 4], ['=EXACT("a","A")', false], ['=EXACT("a","a")', true],
    ['=VALUE("1,234.5")', 1234.5], ['=VALUE("12%")', 0.12], ['=LEN(12345)', 5], ['=CONCATENATE("a",1,TRUE)', 'a1TRUE'], ['=CONCAT(A2:B2)', 'North10'], ['=TEXTJOIN(", ",TRUE,A2:A6)', 'North, South, north, East'], ['=TEXTJOIN("-",FALSE,A5:A6)', 'East-'],
    ['=A2&" ("&B2&")"', 'North (10)'], ['="x"&TRUE', 'xTRUE'],
    ['=TEXT(1234.5,"#,##0.00")', '1,234.50'], ['=TEXT(1234.5,"0")', '1235'], ['=TEXT(0.256,"0.0%")', '25.6%'], ['=TEXT(5,"00")', '05'], ['=TEXT(0.5,"0.00")', '0.50'], ['=TEXT(1234567,"#,##0")', '1,234,567'], ['=TEXT(-3.14159,"0.00")', '-3.14'], ['=TEXT(1.5,"$#,##0.00")', '$1.50'], ['=TEXT(2.5,"0.##")', '2.5'], ['=TEXT(3,"0.##")', '3'],
    ['=TEXT(D2,"yyyy-mm-dd")', '2024-01-15'], ['=TEXT(D2,"dd/mm/yyyy")', '15/01/2024'], ['=TEXT(D2,"mmm yyyy")', 'Jan 2024'], ['=TEXT(D2,"mmmm d, yyyy")', 'January 15, 2024'], ['=TEXT(D2,"dddd")', 'Monday'], ['=TEXT(D2,"ddd")', 'Mon'], ['=TEXT("abc","0.00")', 'abc'],
  ]);
  assert.equal(error('=FIND("z","Hello")'), '#VALUE!'); assert.equal(error('=LEFT("a",-1)'), '#VALUE!'); assert.equal(error('=VALUE("abc")'), '#VALUE!'); assert.equal(error('=MID("abc",0,1)'), '#VALUE!');
  unsupported('=TEXT(5,"0.00E+00")'); unsupported('=TEXT(0.5,"# ?/?")');
});

test('dates use 1900 serial numbers and overflow like a spreadsheet', () => {
  table([
    ['=DATE(2024,2,29)', serial(2024, 2, 29)], ['=DATE(2024,13,1)', serial(2025, 1, 1)], ['=DATE(2024,3,0)', serial(2024, 2, 29)], ['=DATE(24,1,1)', serial(1924, 1, 1)], ['=YEAR(D2)', 2024], ['=MONTH(D2)', 1], ['=DAY(D2)', 15],
    ['=EDATE(D2,1)', D.feb15], ['=EDATE(DATE(2024,1,31),1)', serial(2024, 2, 29)], ['=EDATE(D2,-2)', serial(2023, 11, 15)], ['=EOMONTH(D2,0)', D.jan31], ['=EOMONTH(D2,1)', serial(2024, 2, 29)], ['=DAYS(D3,D2)', 31], ['=D3-D2', 31],
    ['=WEEKDAY(D2)', 2], ['=WEEKDAY(D2,2)', 1], ['=WEEKDAY(D2,3)', 0], ['=YEAR(D2+365)', 2025],
  ]);
  assert.equal(error('=DATE(10000,1,1)'), '#NUM!'); unsupported('=TODAY()'); unsupported('=NOW()'); unsupported('=YEAR(5)');
});

test('lookup functions: exact, approximate, wildcard, row and column forms, and the errors they raise', () => {
  table([
    ['=VLOOKUP("south",A2:C5,3,FALSE)', 3], ['=VLOOKUP("East",A2:C5,2,0)', 15], ['=VLOOKUP("so*",A2:C5,2,FALSE)', 20], ['=VLOOKUP(7,T!A1:B3,2,TRUE)', 'mid'], ['=VLOOKUP(10,T!A1:C3,3)', 'z'], ['=VLOOKUP(7,T!A1:B3,2)', 'mid'],
    ['=HLOOKUP("Units",A1:D5,3,FALSE)', 20], ['=MATCH("south",A2:A5,0)', 2], ['=MATCH(7,T!A1:A3,1)', 2], ['=MATCH(10,T!A1:A3,0)', 3], ['=INDEX(A2:C5,2,3)', 3], ['=INDEX(B2:B5,3)', 5], ['=INDEX(T!A1:C1,3)', 'x'], ['=INDEX(A2:C5,MATCH("East",A2:A5,0),2)', 15],
    ['=XLOOKUP("East",A2:A5,B2:B5)', 15], ['=XLOOKUP("zz",A2:A5,B2:B5,"none")', 'none'], ['=IFERROR(VLOOKUP("zz",A2:C5,2,FALSE),"missing")', 'missing'],
  ]);
  assert.equal(error('=VLOOKUP("zzz",A2:C5,2,FALSE)'), '#N/A'); assert.equal(error('=VLOOKUP("a",A2:C5,9,FALSE)'), '#REF!'); assert.equal(error('=MATCH("zz",A2:A5,0)'), '#N/A'); assert.equal(error('=INDEX(A2:C5,9,1)'), '#REF!'); assert.equal(error('=XLOOKUP("zz",A2:A5,B2:B5)'), '#N/A'); assert.equal(error('=VLOOKUP(0,T!A1:B3,2,TRUE)'), '#N/A');
  unsupported('=INDEX(A2:C5,0,2)');
});

test('whole-column references use the sheet extent; without one they stay unsupported', () => {
  table([['=SUM(B:B)', 50], ['=COUNTIF(A:A,"north")', 2], ['=SUMIF(A:A,"South",B:B)', 20], ['=MAX(S!B:B)', 20], ['=VLOOKUP("East",A:C,2,FALSE)', 15], ['=SUM(T!A:A)', 16]]);
  assert.equal(evaluateFormula('=SUM(B:B)', lookup, 'S').unsupported, true);
  assert.equal(calc('=SUM(Nowhere!A:A)').unsupported, true);
});

test('what cannot be calculated is left uncached, and errors are named like a spreadsheet names them', () => {
  unsupported('=NOSUCH(1)'); unsupported('=SUM(B2:B5*2)'); unsupported('=SUM(B2:B5)+A2:A3'); unsupported('=XLOOKUP("East",A2:A5,B2:B5,"x",1)');
  assert.equal(error('=1/0'), '#DIV/0!'); assert.equal(error('=A2+1'), '#VALUE!'); assert.equal(error('=SUM(B2:B5)/0'), '#DIV/0!'); assert.equal(error('=2^2000'), '#NUM!');
  assert.equal(calc('=1 +').ok, false);
  assert.deepEqual(calc('=B2'), { ok: true, value: 10 }); assert.deepEqual(calc('=A6'), { ok: true, value: 0 }, 'an empty result is zero, as a formula cell shows it');
  const circular = evaluateFormula('=A1', () => ({ formula: '=A1' }), 'S');
  assert.equal(circular.ok, false);
});

/* ───── oracle: the same formulas, calculated by LibreOffice, must give the same answers ───── */
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { buildXlsx } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/office-build.ts')));
const { readOffice } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/office-read.ts')));
const { openZip, writeZip } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/office-zip.ts')));
const { findOfficeSuite } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/office-render.ts')));

/** Formulas whose result a real spreadsheet engine must reproduce. Excluded on purpose: two-digit years (a LibreOffice setting decides the century) and TRUE inside text (Excel prints TRUE, LibreOffice prints 1). */
const ORACLE = [
  '=SUMIF(A2:A5,"North",B2:B5)', '=SUMIF(B2:B5,">9")', '=SUMIF(A2:A5,"n*",B2:B5)', '=SUMIF(A2:A5,"<>North",B2:B5)', '=SUMIF(A2:A5,"?outh",B2:B5)', '=COUNTIF(A2:A5,"North")', '=COUNTIF(B2:B5,">=15")', '=COUNTIF(A2:A6,"")', '=COUNTIF(A2:A6,"<>")',
  '=COUNTIF(B2:B5,10)', '=SUMIFS(B2:B5,A2:A5,"north",C2:C5,">3")', '=COUNTIFS(A2:A5,"north",B2:B5,">7")', '=AVERAGEIF(A2:A5,"north",B2:B5)', '=AVERAGEIFS(B2:B5,B2:B5,">5")', '=MAXIFS(B2:B5,A2:A5,"north")', '=MINIFS(B2:B5,A2:A5,"north")', '=MAXIFS(B2:B5,A2:A5,"nobody")',
  '=SUMPRODUCT(B2:B5,C2:C5)', '=SUMIF(B2:B5,">"&5,C2:C5)', '=COUNTIF(D2:D5,">"&DATE(2024,2,1))', '=MEDIAN(B2:B5)', '=VAR.S(B2:B5)', '=VAR(B2:B5)', '=VAR.P(B2:B5)', '=STDEV.S(B2:B5)', '=STDEV(B2:B5)', '=STDEV.P(B2:B5)', '=LARGE(B2:B5,2)', '=SMALL(B2:B5,1)', '=COUNTBLANK(A2:A6)', '=PRODUCT(B2:B3)', '=SIGN(-3)', '=INT(-2.5)', '=MOD(-3,2)', '=MOD(3,-2)', '=POWER(2,10)', '=SQRT(16)',
  '=ROUND(2.675,2)', '=ROUND(1234.5678,-2)', '=ROUND(-2.5,0)', '=ROUNDUP(2.341,2)', '=ROUNDDOWN(-2.349,2)', '=ROUNDUP(1.1,0)', '=CEILING(2.1,0.5)', '=FLOOR(2.7,0.5)', '=0.1+0.2&""', '=1/3&""', '=SUM(A2,B2)', '=COUNT(A2,B2)', '=AVERAGE(B2,B3,C2)', '=SQRT(-1)', '=POWER(0,-1)', '=MOD(1,0)', '=1/0', '=A2+1', '=2^2000',
  '=IFS(B2>50,"a",B2>5,"b",TRUE,"c")', '=SWITCH(B2,10,"ten",20,"twenty","other")', '=SWITCH(99,10,"ten","other")', '=CHOOSE(2,"a","b","c")', '=CHOOSE(2,1/0,"b")', '=IFNA(VLOOKUP("zzz",A2:C5,2,FALSE),"none")', '=IFERROR(VLOOKUP("zzz",A2:C5,2,FALSE),0)', '=ISERROR(1/0)', '=ISBLANK(A6)', '=ISNUMBER(B2)', '=ISTEXT(A2)',
  '=IF(A6="","blank","filled")', '=A6=0', '=B2>"a"', '="a"<"B"', '="a"="A"', '=IF(AND(B2>5,C2<3),"yes","no")', '=OR(B2>50,C2>50)', '=NOT(B2>50)', '=IF(B2>5,"big")', '=IF(B2>50,"big")', '=IFS(B2>50,"a")', '=CHOOSE(5,"a")',
  '=LEFT("Hello",2)', '=LEFT("Hello")', '=RIGHT("Hello",3)', '=MID("Hello",2,3)', '=UPPER("aB")', '=LOWER("aB")', '=PROPER("hello wORLD 2nd")', '=TRIM("  a   b ")', '=SUBSTITUTE("a-b-c","-","+")', '=SUBSTITUTE("a-b-c","-","+",2)', '=REPT("ab",3)', '=FIND("l","Hello")', '=SEARCH("L","Hello")', '=FIND("l","Hello",4)',
  '=EXACT("a","A")', '=VALUE("1,234.5")', '=VALUE("12%")', '=LEN(12345)', '=CONCAT(A2:B2)', '=TEXTJOIN(", ",TRUE,A2:A6)', '=TEXTJOIN("-",FALSE,A5:A6)', '=A2&" ("&B2&")"', '=FIND("z","Hello")', '=LEFT("a",-1)', '=VALUE("abc")',
  '=TEXT(1234.5,"#,##0.00")', '=TEXT(1234.5,"0")', '=TEXT(0.256,"0.0%")', '=TEXT(5,"00")', '=TEXT(0.5,"0.00")', '=TEXT(1234567,"#,##0")', '=TEXT(-3.14159,"0.00")', '=TEXT(2.5,"0.##")', '=TEXT(3,"0.##")', '=TEXT(D2,"yyyy-mm-dd")', '=TEXT(D2,"dd/mm/yyyy")', '=TEXT(D2,"mmm yyyy")', '=TEXT(D2,"mmmm d, yyyy")', '=TEXT(D2,"dddd")', '=TEXT(D2,"ddd")',
  '=DATE(2024,2,29)', '=DATE(2024,13,1)', '=DATE(2024,3,0)', '=YEAR(D2)', '=MONTH(D2)', '=DAY(D2)', '=EDATE(D2,1)', '=EDATE(DATE(2024,1,31),1)', '=EDATE(D2,-2)', '=EOMONTH(D2,0)', '=EOMONTH(D2,1)', '=DAYS(D3,D2)', '=D3-D2', '=WEEKDAY(D2)', '=WEEKDAY(D2,2)', '=WEEKDAY(D2,3)', '=YEAR(D2+365)',
  '=VLOOKUP("south",A2:C5,3,FALSE)', '=VLOOKUP("East",A2:C5,2,0)', '=VLOOKUP("so*",A2:C5,2,FALSE)', '=VLOOKUP(7,T!A1:B3,2,TRUE)', '=VLOOKUP(10,T!A1:C3,3)', '=VLOOKUP(7,T!A1:B3,2)', '=HLOOKUP("Units",A1:D5,3,FALSE)', '=MATCH("south",A2:A5,0)', '=MATCH(7,T!A1:A3,1)', '=MATCH(10,T!A1:A3,0)',
  '=INDEX(A2:C5,2,3)', '=INDEX(B2:B5,3)', '=INDEX(T!A1:C1,3)', '=INDEX(A2:C5,MATCH("East",A2:A5,0),2)', '=XLOOKUP("East",A2:A5,B2:B5)', '=XLOOKUP("zz",A2:A5,B2:B5,"none")', '=VLOOKUP("zzz",A2:C5,2,FALSE)', '=VLOOKUP("a",A2:C5,9,FALSE)', '=MATCH("zz",A2:A5,0)', '=INDEX(A2:C5,9,1)', '=VLOOKUP(0,T!A1:B3,2,TRUE)',
  '=SUM(B:B)', '=COUNTIF(A:A,"north")', '=SUMIF(A:A,"South",B:B)', '=MAX(S!B:B)', '=VLOOKUP("East",A:C,2,FALSE)', '=SUM(T!A:A)',
];

test('oracle: LibreOffice calculates the same results for the whole battery', { timeout: 240_000 }, async (t) => {
  const suite = findOfficeSuite();
  if (!suite || process.env.YUNUSPI_SKIP_OFFICE_RENDER === '1') return t.skip('LibreOffice is not installed (or rendering is skipped)');
  // Formulas live in column F of sheet S, below and beside the data, so unqualified references mean what they mean in the unit tests.
  const rows = ORACLE.map((formula, index) => [...(sheets.S[index] ?? [null, null, null, null]), null, formula]);
  const spec = { sheets: [{ name: 'S', rows }, { name: 'T', rows: sheets.T }] };
  const built = buildXlsx(spec);
  const engine = new Map(); // formula row -> value stored by the built-in calculator
  const own = path.join(os.tmpdir(), `oracle-own-${process.pid}.xlsx`); fs.writeFileSync(own, built.buffer);
  try {
    const mine = readOffice(own, { maxRows: 200, maxCols: 8 }).sheets.find(sheet => sheet.name === 'S');
    for (const row of mine.sample) { const f = row.find(cell => cell.ref.startsWith('F')); if (f) engine.set(Number(f.ref.slice(1)), f.value); }
  } finally { fs.rmSync(own, { force: true }); }
  // Remove every stored result so the other engine has to calculate each formula itself.
  const zip = openZip(built.buffer);
  const stripped = writeZip(zip.entries.filter(entry => !entry.directory).map(entry => {
    let data = zip.read(entry.name);
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) data = Buffer.from(data.toString('utf8').replace(/<c\b([^>]*)>(<f>[\s\S]*?<\/f>)<v>[\s\S]*?<\/v><\/c>/g, (_whole, attrs, f) => `<c${attrs.replace(/\s+t="[^"]*"/, '')}>${f}</c>`));
    return { name: entry.name, data };
  }));
  const staging = fs.mkdtempSync(path.join(os.homedir(), 'yunuspi-oracle-'));
  try {
    fs.writeFileSync(path.join(staging, 'input.xlsx'), stripped);
    await promisify(execFile)(suite, ['--headless', '--norestore', '--nologo', `-env:UserInstallation=file://${path.join(staging, 'profile')}`, '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', path.join(staging, 'out'), path.join(staging, 'input.xlsx')], { cwd: staging, timeout: 180_000 });
    const converted = readOffice(path.join(staging, 'out', 'input.xlsx'), { maxRows: 200, maxCols: 8 }).sheets.find(sheet => sheet.name === 'S');
    const other = new Map();
    for (const row of converted.sample) { const f = row.find(cell => cell.ref.startsWith('F')); if (f) other.set(Number(f.ref.slice(1)), f.value); }
    const differences = [], skipped = [];
    ORACLE.forEach((formula, index) => {
      const mineValue = engine.get(index + 1), theirs = other.get(index + 1);
      if (mineValue === undefined || mineValue === null && !/^=(?:A6|IF\(A6)/.test(formula) && built.sheets[0].uncalculated.some(entry => entry.startsWith(`F${index + 1} `))) { skipped.push(formula); return; }
      // LibreOffice stores booleans as 0/1, formats DATE() results as dates, and exports its own error codes for the same failures.
      const norm = (v) => typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? serial(...v.split('-').map(Number)) : v;
      const a = norm(mineValue), b = norm(theirs), isError = (v) => typeof v === 'string' && /^#[A-Z0-9/!?]+$/.test(v);
      const equal = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) : (isError(a) && isError(b)) || a === b || (a === 0 && (b === null || b === undefined));
      if (!equal) differences.push(`${formula}  engine=${JSON.stringify(mineValue)}  libreoffice=${JSON.stringify(theirs)}`);
    });
    assert.ok(skipped.length <= 2, `the calculator should cover the battery; left uncalculated: ${skipped.join(' | ')}`);
    assert.deepEqual(differences, [], `results that differ from LibreOffice:\n${differences.join('\n')}`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
});
