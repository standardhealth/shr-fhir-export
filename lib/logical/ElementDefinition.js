const isEqual = require('lodash/isEqual');
const cloneDeep = require('lodash/cloneDeep');

class ElementDefinition {
  constructor(id='') {
    this.id = id;
  }

  // Boring stuff based on FHIR definition of ElementDefinition

  get id() { return this._id; }
  set id(id) {
    this._id = id;
    // After setting the id, we should re-set the path, which is based on the id
    this._path = this._id.split('.').map(s => /^[^:]*/.exec(s)[0]).join('.');
  }

  get extension() { return this._extension; }
  set extension(extension) { this._extension = extension; }

  get path() { return this._path; }
  set path(path) { this._path = path; }

  get representation() { return this._representation; }
  set representation(representation) { this._representation = representation; }

  get sliceName() { return this._sliceName; }
  set sliceName(sliceName) { this._sliceName = sliceName; }

  get label() { return this._label; }
  set label(label) { this._label = label; }

  get code() { return this._code; }
  set code(code) { this._code = code; }

  get slicing() { return this._slicing; }
  set slicing(slicing) { this._slicing = slicing; }

  get short() { return this._short; }
  set short(short) { this._short = short; }

  get definition() { return this._definition; }
  set definition(definition) { this._definition = definition; }

  get comment() { return this._comment; }
  set comment(comment) { this._comment = comment; }

  get requirements() { return this._requirements; }
  set requirements(requirements) { this._requirements = requirements; }

  get alias() { return this._alias; }
  set alias(alias) { this._alias = alias; }

  get min() { return this._min; }
  set min(min) { this._min = min; }

  get max() { return this._max; }
  set max(max) { this._max = max; }

  get base() { return this._base; }
  set base(base) { this._base = base; }

  get contentReference() { return this._contentReference; }
  set contentReference(contentReference) { this._contentReference = contentReference; }

  get type() { return this._type; }
  set type(type) { this._type = type; }

  get defaultValue() { return this._defaultValue; }
  set defaultValue(defaultValue) { this._defaultValue = defaultValue; }

  get meaningWhenMissing() { return this._meaningWhenMissing; }
  set meaningWhenMissing(meaningWhenMissing) { this._meaningWhenMissing = meaningWhenMissing; }

  get orderMeaning() { return this._orderMeaning; }
  set orderMeaning(orderMeaning) { this._orderMeaning = orderMeaning; }

  get fixed() { return this._fixed; }
  set fixed(fixed) { this._fixed = fixed; }

  get pattern() { return this._pattern; }
  set pattern(pattern) { this._pattern = pattern; }

  get example() { return this._example; }
  set example(example) { this._example = example; }

  get minValue() { return this._minValue; }
  set minValue(minValue) { this._minValue = minValue; }

  get maxValue() { return this._maxValue; }
  set maxValue(maxValue) { this._maxValue = maxValue; }

  get maxLength() { return this._maxLength; }
  set maxLength(maxLength) { this._maxLength = maxLength; }

  get condition() { return this._condition; }
  set condition(condition) { this._condition = condition; }

  get constraint() { return this._constraint; }
  set constraint(constraint) { this._constraint = constraint; }

  get mustSupport() { return this._mustSupport; }
  set mustSupport(mustSupport) { this._mustSupport = mustSupport; }

  get isModifier() { return this._isModifier; }
  set isModifier(isModifier) { this._isModifier = isModifier; }

  get isSummary() { return this._isSummary; }
  set isSummary(isSummary) { this._isSummary = isSummary; }

  get binding() { return this._binding; }
  set binding(binding) { this._binding = binding; }

  get mapping() { return this._mapping; }
  set mapping(mapping) { this._mapping = mapping; }

  // Interesting stuff to make this class useful!

  get structDef() { return this._structDef; }
  set structDef(structDef) { this._structDef = structDef; }

  newChildElement(name='$UNKNOWN') {
    const el = new ElementDefinition(`${this.id}.${name}`);
    el.structDef = this.structDef;
    return el;
  }

  captureOriginal() {
    this._original = cloneDeep(this);
  }

  hasDiff() {
    const original = this._original ? this._original : new ElementDefinition();
    return PROPS.some(prop => !isEqual(this[prop], original[prop]));
  }

  calculateDiff() {
    const original = this._original ? this._original : new ElementDefinition();
    const diff = new ElementDefinition();
    for (const prop of PROPS) {
      if (!isEqual(this[prop], original[prop])) diff[prop] = cloneDeep(this[prop]);
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
    const ed = new ElementDefinition();
    for (const prop of PROPS) {
      if (json[prop] !== undefined) {
        ed[prop] = cloneDeep(json[prop]);
      }
    }
    return ed;
  }

  toJSON() {
    const j = {};
    for (const prop of PROPS) {
      if (this[prop] !== undefined) {
        j[prop] = cloneDeep(this[prop]);
      }
    }
    return j;
  }
}

const PROPS = [ 'id', 'extension', 'path', 'representation', 'sliceName', 'label', 'code',
  'slicing', 'short', 'definition', 'comment', 'requirements', 'alias', 'min', 'max', 'base',
  'contentReference', 'type', 'defaultValue', 'meaningWhenMissing', 'orderMeaning', 'fixed', 'pattern',
  'example', 'minValue', 'maxValue', 'maxLength', 'condition', 'constraint', 'mustSupport', 'isModifier',
  'isSummary', 'binding', 'mapping' ];

module.exports = ElementDefinition;