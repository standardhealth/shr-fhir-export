const common = require('./common');

class QA {
  constructor() {
    this._rows = [];
  }

  basic(profileId) {
    this.log('BASIC', 'Element profiled on Basic', profileId);
  }

  codeNotConstrained(property, profileId, path) {
    const m = `${property} is not bound to a value set or fixed to a code`;
    this.log('UNMAPPED_PROP', m, profileId, path);
  }

  conversionDropsConstraint(constraintType, from, to, profileId, path) {
    [from, to] = fix(from, to);
    const m = `Conversion from ${from} to one of ${to} drops ${constraintType} constraints`;
    this.log('CST_DROPPED', m, profileId, path);
  }

  overrideConstraint(constraintType, from, to, profileId, path) {
    [from, to] = fix(from, to);
    const m = `Cannot override ${constraintType} constraint from ${from} to ${to}`;
    this.log('CST_OVERRIDE', m, profileId, path);
  }

  propertyNotMapped(property, profileId, path) {
    const m = `${property} is not mapped (but probably should be)`;
    this.log('UNMAPPED_PROP', m, profileId, path);
  }

  log(category, message, profileId, path) {
    this._rows.push(new Row(category, message, profileId, path));
  }

  sortByCategory() {
    this._rows.sort((a, b) => {
      const cmpCat = compareStrings(a.category, b.category);
      if (cmpCat != 0) return cmpCat;
      const cmpPrf = compareStrings(a.profileId, b.profileId);
      if (cmpPrf != 0) return cmpPrf;
      return compareStrings(a.path, b.path);
    });
  }

  toString() {
    this.sortByCategory();
    let str = '';
    for (const r of this._rows) {
      str += `${r.toString()}\n`;
    }
    str += `${this._rows.length} messages.`;
    return str;
  }

  toErrors() {
    this.sortByCategory();
    return this._rows.map(r => new common.FHIRExportError(r.toString()));
  }

  toHTML() {
    this.sortByCategory();
    let html = `<!DOCTYPE html>
<html>
<head>
<style>
table {
    font-family: arial, sans-serif;
    border-collapse: collapse;
    width: 100%;
}

td, th {
    border: 1px solid #dddddd;
    text-align: left;
    padding: 8px;
}

tr:nth-child(even) {
    background-color: #dddddd;
}
</style>
</head>
<body>
<h1>SHR QA Report (${this._rows.length} warnings)</h1>
<table>
  <tr>
    <th>Category</th>
    <th>Profile</th>
    <th>Message</th>
    <th>Path</th>
  </tr>
`;
    for (const r of this._rows) {
      html += `  <tr>
    <td>${common.escapeHTML(r.category)}</td>
    <td>${common.escapeHTML(r.profileId)}</td>
    <td>${common.escapeHTML(r.message)}</td>
    <td>${common.escapeHTML(r.path)}</td>
  </tr>
`;
    }
    return html + `</table>

  </body>
</html>`;
  }
}

function fix(...things) {
  return things.map(t => typeof t === 'object' ? JSON.stringify(t) : t);
}

class Row {
  constructor(category, message, profileId, path) {
    this._category = category;
    this._message = message;
    this._profileId = profileId;
    this._path = path;
  }

  get category() { return this._category; }
  get message() { return this._message; }
  get profileId() { return this._profileId; }
  get path() { return this._path; }

  toString() {
    let str = `[${this.category}] ${this.profileId}: ${this.message}`;
    if (typeof this.path !== 'undefined') {
      str += ` (${this.path})`;
    }
    return str;
  }
}

function compareStrings(a, b) {
  if (a && b) {
    [a, b] = [a.toLowerCase(), b.toLowerCase()];
    if (a < b) return -1;
    else if (b < a) return 1;
    else return 0;
  } else if (a) {
    return -1;
  } else if (b) {
    return 1;
  }
  return 0;
}

module.exports = {QA};
