// A table as CSV for Excel and other spreadsheets: semicolons (what German Excel expects), every
// cell quoted, and a byte order mark so Excel reads UTF-8. A cell that starts with =, +, -, @, a tab
// or a carriage return gets a leading ', so a visitor's text never becomes a formula.
const cell = (value) => {
  const text = String(value ?? '');
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

export const csv = (rows) => `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
