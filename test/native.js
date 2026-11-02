// Test fixtures write library paths with '/'. The library stores native
// paths ('\' on Windows), so fixtures go through P() to become one.
const path = require('path');

const P = (s) => (path.sep === '/' ? s : String(s).replace(/\//g, path.sep));

module.exports = { P };
