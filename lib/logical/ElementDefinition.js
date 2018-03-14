const isEqual = require('lodash/isEqual');
const cloneDeep = require('lodash/cloneDeep');
const common = require('../common');

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

  // defaultValue[x] can be literally almost any field name (e.g., defaultValueCode, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  get meaningWhenMissing() { return this._meaningWhenMissing; }
  set meaningWhenMissing(meaningWhenMissing) { this._meaningWhenMissing = meaningWhenMissing; }

  get orderMeaning() { return this._orderMeaning; }
  set orderMeaning(orderMeaning) { this._orderMeaning = orderMeaning; }

  // fixed[x] can be literally almost any field name (e.g., fixedCode, fixedFoo, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  // pattern[x] can be literally almost any field name (e.g., patternCode, patternFoo, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  get example() { return this._example; }
  set example(example) { this._example = example; }

  // minValue[x] can be many different field names (e.g., minValueDate, minValueQuantity, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  // maxValue[x] can be many different field names (e.g., maxValueDate, maxValueQuantity, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

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
    this._original = this.clone();
  }

  clearOriginal() {
    this._original = null;
  }

  hasDiff() {
    const original = this._original ? this._original : new ElementDefinition();
    return PROPS.some(prop => {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0,-3)}[A-Z].*$`);
        prop = Object.keys(this).find(p => re.test(p));
        if (prop == null) {
          prop = Object.keys(original).find(p => re.test(p));
        }
      }
      return prop && !isEqual(this[prop], original[prop]);
    });
  }

  calculateDiff() {
    const original = this._original ? this._original : new ElementDefinition();
    const diff = new ElementDefinition();
    for (let prop of PROPS) {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0,-3)}[A-Z].*$`);
        prop = Object.keys(this).find(p => re.test(p));
        if (prop == null) {
          prop = Object.keys(original).find(p => re.test(p));
        }
      }
      if (prop && !isEqual(this[prop], original[prop])) diff[prop] = cloneDeep(this[prop]);
    }
    return diff;
  }

  bindToVS(vsURI, strength, path, resolve) {
    // TODO: Add error checking such as (1) if this is a code-ish element, (2) if there already is a binding.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    if (path && path.length > 0) {
      const child = this.findChild(path, resolve);
      if (child) {
        return child.bindToVS(vsURI, strength);
      }
      return;
    }

    // This is the element to bind it to
    this.binding = {
      strength,
      valueSetReference: {
        reference: vsURI
      }
    };
    return this;
  }

  fixCode(code, path, resolve) {
    // TODO: Add error checking such as (1) if this is a code-ish element, (2) if there already is a fixed code.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    if (path && path.length > 0) {
      const child = this.findChild(path, resolve);
      if (child) {
        return child.fixCode(code, null, resolve);
      }
      return;
    }

    // This is the element to fix it to
    if (this.type.some(t => t.code === 'CodeableConcept')) {
      const coding = this.findChild('coding', resolve);
      if (coding) {
        coding.sliceIt('value', 'code');
        const slice = coding.newSlice(`Fixed_${code.code}`); // TODO: use symbolized version of display if it's there?
        if (code.display) {
          slice.short = code.display;
        }
        slice.fixCode(code, null, resolve);
      }
    } else if (this.type.some(t => t.code === 'Coding')) {
      const codingSystem = this.findChild('system', resolve);
      if (codingSystem) {
        codingSystem.min = 1;
        codingSystem.fixedUri = code.system;
      }
      const codingCode = this.findChild('code', resolve);
      if (codingCode) {
        codingCode.min = 1;
        codingCode.fixedCode = code.code;
      }
    } else if (this.type.some(t => t.code === 'code')) {
      this.fixedCode = code.code;
    } else {
      // Not something we can fix a code on
    }

    if (this.min === 0 && this.max !== '0') {
      this.min = 1;
    }
    if (this.binding) {
      this.binding = undefined;
    }

    return this;
  }

  fixBoolean(value, path, resolve) {
    // TODO: Add error checking such as (1) if this is a boolean element, (2) if there already is a fixed boolean.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    if (path && path.length > 0) {
      const child = this.findChild(path, resolve);
      if (child) {
        return child.fixBoolean(value, null, resolve);
      }
      return;
    }

    // This is the element to fix it to
    this.fixedBoolean = value;
    if (this.min === 0 && this.max !== '0') {
      this.min = 1;
    }

    return this;
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
      // If it's a choice, we need to go further
      let child = children[0];
      if (child.type.length > 1) {
        // For now, we can find the index in the aliases and use that, but we may need a different
        // approach as this evolves.
        const i = child.alias.findIndex(a => a === root);
        if (i > -1 && i < child.type.length) {
          // TODO: Look for existing element instead of just creating one
          // Create the individual slice to apply the constraints to
          child.sliceIt('type', '$this');
          child = child.newSlice(root, child.type[i]);
        }
      }
      return child.findChild(rest, resolve);
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
          const newElements = def.elements.slice(1).map(e => {
            const eClone = e.clone();
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

  sliceIt(discriminatorType, discriminatorPath) {
    // TODO: handle if slicing already exists?
    this._slicing = {
      discriminator : [{
        type: discriminatorType,
        path: discriminatorPath
      }],
      ordered : false,
      rules : 'open'
    };
    return this._slicing;
  }

  newSlice(name, type) {
    // TODO: Ensure that there is already a slicing
    const slice = this.structDef.newElement();
    if (type) {
      slice.id = `${this.id.replace(/\[x\]$/, common.capitalize(nameFromType(type)))}:${name}`;
      slice.type = [type];
    } else {
      slice.id = `${this.id}:${name}`;
      slice.type = cloneDeep(this.type);
    }
    slice.sliceName = name;
    slice.min = this.min;
    slice.max = this.max;
    slice.base = {
      path: this.path,
      min: this.min,
      max: this.max
    };
    slice.mustSupport = this.mustSupport;
    slice.isModifier = this.isModifier;
    slice.isSummary = this.isSummary;
    // TODO: Remove unnecessary / extravagant properties?
    return slice;
  }

  clone(clearOriginal=true) {
    // We don't want to clone the reference to the StructureDefinition, so temporarily save it and remove it
    const savedStructDef = this.structDef;
    this.structDef = null;
    const clone = cloneDeep(this);
    // Set the reference to the StructureDefinition again
    this.structDef = clone.structDef = savedStructDef;
    // Clear original if applicable
    if (clearOriginal) {
      clone.clearOriginal();
    }
    return clone;
  }

  toJSON() {
    const j = {};
    for (let prop of PROPS) {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0,-3)}[A-Z].*$`);
        prop = Object.keys(this).find(p => re.test(p));
      }
      if (prop && this[prop] !== undefined) {
        j[prop] = cloneDeep(this[prop]);
      }
    }
    return j;
  }

  static fromJSON(json) {
    const ed = new ElementDefinition();
    for (let prop of PROPS) {
      if (prop.endsWith('[x]')) {
        const re = new RegExp(`^${prop.slice(0,-3)}[A-Z].*$`);
        prop = Object.keys(json).find(p => re.test(p));
      }
      if (prop && json[prop] !== undefined) {
        ed[prop] = cloneDeep(json[prop]);
      }
    }
    return ed;
  }
}

function nameFromType(type) {
  type = common.typeToString(type);
  // If it's a URI, then just return the last part
  return type.split('/').pop();
}

const PROPS = [ 'id', 'extension', 'path', 'representation', 'sliceName', 'label', 'code',
  'slicing', 'short', 'definition', 'comment', 'requirements', 'alias', 'min', 'max', 'base',
  'contentReference', 'type', 'defaultValue[x]', 'meaningWhenMissing', 'orderMeaning', 'fixed[x]', 'pattern[x]',
  'example', 'minValue[x]', 'maxValue[x]', 'maxLength', 'condition', 'constraint', 'mustSupport', 'isModifier',
  'isSummary', 'binding', 'mapping' ];

module.exports = ElementDefinition;