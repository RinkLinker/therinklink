const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('const RINKS=[');
const arrStart = start + 'const RINKS='.length;
let i = arrStart;
let depth = 0;
let inStr = false, strChar = '';
do {
  const c = html[i];
  if (inStr) {
    if (c === strChar && html[i-1] !== String.fromCharCode(92)) inStr = false;
  } else {
    if (c === '"' || c === "'") { inStr = true; strChar = c; }
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  i++;
} while (depth > 0);
const arrStr = html.slice(arrStart, i);
let RINKS;
eval('RINKS=' + arrStr);
console.log('Count:', RINKS.length);
console.log('First rink keys:', Object.keys(RINKS[0]));
console.log('First rink:', JSON.stringify(RINKS[0], null, 2));
console.log('Second rink:', JSON.stringify(RINKS[1], null, 2));
