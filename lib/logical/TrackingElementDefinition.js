const isEqual = require('lodash/isEqual');
const cloneDeep = require('lodash/cloneDeep');
const ElementDefinition = require('./ElementDefinition');

module.exports = class TrackingElementDefinition extends ElementDefinition {
  constructor(id) {
    super(id);
    this._original = new ElementDefinition();
  }

  get structDef() { return this._structDef; }
  set structDef(structDef) { this._structDef = structDef; }

  newChildElement(name='$UNKNOWN') {
    const el = new TrackingElementDefinition(`${this.id}.${name}`);
    el.structDef = this.structDef;
    return el;
  }

  captureOriginal() {
    this._original = cloneDeep(this);
  }

  hasDiff() {
    return ElementDefinition._PROPS.some(prop => !isEqual(this[prop], this._original[prop]));
  }

  calculateDiff() {
    const diff = new ElementDefinition();
    for (const prop of ElementDefinition._PROPS) {
      if (!isEqual(this[prop], this._original[prop])) diff[prop] = cloneDeep(this[prop]);
    }
    return diff;
  }

  applyBinding(vsURI, strength, path, resolve) {
    // TODO: Add error checking such as (1) if this is a code-ish element, (2) if there already is a binding.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    if (path && path.length > 0) {
      const child = this.findChild(path, resolve);
      if (child) {
        child.applyBinding(vsURI, strength);
      }
    } else {
      this.binding = {
        strength,
        valueSetReference: {
          reference: vsURI
        }
      };
      return this;
    }
  }

  findChild(path, resolve = (arg) => null) {
    if (!path || path.length == 0) {
      return this;
    }

    // Re-usable function to check for a matching path w/ special support for looking at aliases.
    // This is needed because we rename specific types to 'value' or 'value[x]' when appropriate, but
    // sometimes those elements might be searched by the specific type name (instead of value/value[x]).
    const pathMatches = (element, base, tail) => {
      return element.path === `${base}.${tail}`
        || (
          (element.path === `${base}.value` || element.path === `${base}.value[x]`)
            && element.alias && element.alias.some(a => a === tail)
        );
    };

    const [root, rest] = path.split('.', 2);
    const children = this.structDef.elements.filter(e => {
      return e.id.startsWith(this.id) && pathMatches(e, this.path, root);
    });
    if (children.length === 1) {
      return children[0].findChild(rest, resolve);
    } else if (children.length > 1) {
      // TODO: Log error/warning
    } else {
      if (this.type.length === 1) {
        const def = resolve(this.type[0]);
        if (def) {
          // Check if it has the thing we're looking for
          const rootEl = def.elements.find(e => pathMatches(e, def.type, root));
          if (!rootEl) {
            return;
          }
          const newElements = def.elements.filter(e => e.path.startsWith(`${rootEl.path}`)).map(e => {
            const eClone = cloneDeep(e);
            eClone.id = eClone.id.replace(def.type, `${this.id}`);
            eClone.structDef = this.structDef;
            return eClone;
          });
          this.structDef.elements.push(...newElements);
          return this.findChild(path, resolve);
        }
      }

    }
  }

  static fromJSON(json) {
    const ed = new TrackingElementDefinition();
    for (const prop of ElementDefinition._PROPS) {
      if (json[prop] !== undefined) {
        ed[prop] = cloneDeep(json[prop]);
      }
    }
    return ed;
  }
};