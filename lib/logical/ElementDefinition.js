const isEqual = require('lodash/isEqual');
const cloneDeep = require('lodash/cloneDeep');
const escapeRegExp = require('lodash/escapeRegExp');
const common = require('../common');

/** @typedef {import('./StructureDefinition')} StructureDefinition */

/**
 * A class representing a FHIR ElementDefinition.  For the most part, each allowable property in an ElementDefinition
 * is represented via a get/set in this class, and the value is expected to be the FHIR-compliant JSON that would go
 * in the StructureDefinition JSON file.
 * @see {@link http://hl7.org/fhir/STU3/elementdefinition.html|FHIR ElementDefinition}
 */
class ElementDefinition {
  /**
   * Constructs a new ElementDefinition with the given ID.
   * @param {string} id - the ID of the ElementDefinition
   */
  constructor(id='') {
    this.id = id;
  }

  /**
   * @returns {string} id
   */
  get id() { return this._id; }
  /**
   * Sets the id of the ElementDefinition and updates the path accordingly.
   * NOTE: This does not automatically update child ids/paths.  That is currently up to the library user.
   * @param {string} id - the ElementDefinition id
   */
  set id(id) {
    this._id = id;
    // After setting the id, we should re-set the path, which is based on the id
    this._path = this._id.split('.').map(s => /^[^:]*/.exec(s)[0]).join('.');
    // If the base was explicitly set, we need to set the path there too
    if (this._base != null && this._base.path.startsWith(`${this.structDef.type}.`)) {
      this._base.path = this._path;
    }
  }

  /**
   * @returns {Object[]} extension
   */
  get extension() { return this._extension; }
  /**
   * @param {Object[]} extension
   */
  set extension(extension) { this._extension = extension; }

  /**
   * @returns {string} path
   */
  get path() { return this._path; }
  /**
   * @param {string} path
   */
  set path(path) { this._path = path; }

  /**
   * @returns {string[]} representation
   */
  get representation() { return this._representation; }
  /**
   * @param {string[]} representation
   */
  set representation(representation) { this._representation = representation; }

  /**
   * @returns {string} sliceName
   */
  get sliceName() { return this._sliceName; }
  /**
   * @param {string} sliceName
   */
  set sliceName(sliceName) { this._sliceName = sliceName; }

  /**
   * @returns {string} label
   */
  get label() { return this._label; }
  /**
   * @param {string} label
   */
  set label(label) { this._label = label; }

  /**
   * @returns {Object[]} code
   */
  get code() { return this._code; }
  /**
   * @param {Object[]} code
   */
  set code(code) { this._code = code; }

  /**
   * @returns {{discriminator?: {type: string, path: string}[], description?: string, ordered?: boolean, rules: string}} slicing
   */
  get slicing() { return this._slicing; }
  /**
   * @param {{discriminator?: {type: string, path: string}[], description?: string, ordered?: boolean, rules: string}} slicing
   */
  set slicing(slicing) { this._slicing = slicing; }

  /**
   * @returns {string} short
   */
  get short() { return this._short; }
  /**
   * @param {string} short
   */
  set short(short) { this._short = short; }

  /**
   * @returns {string} definition
   */
  get definition() { return this._definition; }
  /**
   * @param {string} definition
   */
  set definition(definition) { this._definition = definition; }

  /**
   * @returns {string} comment
   */
  get comment() { return this._comment; }
  /**
   * @param {string} comment
   */
  set comment(comment) { this._comment = comment; }

  /**
   * @returns {string} requirements
   */
  get requirements() { return this._requirements; }
  /**
   * @param {string} requirements
   */
  set requirements(requirements) { this._requirements = requirements; }

  /**
   * @returns {string[]} alias
   */
  get alias() { return this._alias; }
  /**
   * @param {string[]} alias
   */
  set alias(alias) { this._alias = alias; }

  /**
   * @returns {number} min
   */
  get min() { return this._min; }
  /**
   * @param {number} min
   */
  set min(min) { this._min = min; }

  /**
   * @returns {string} max
   */
  get max() { return this._max; }
  /**
   * @param {string} max
   */
  set max(max) { this._max = max; }

  /**
   * Gets the base.  If the base was not explicitly set, defaults to a base with this element's path, min, and max.
   * @returns {{path: string, min: number, max: string}} base
   */
  get base() {
    if (this._base) {
      return this._base;
    }

    // There is no specific base set, so return a base corresponding to the current element
    return {
      path: this.path,
      min: this.min,
      max: this.max
    };
  }
  /**
   * @param {{path: string, min: number, max: string}} base
   */
  set base(base) { this._base = base; }

  /**
   * Resets the base to undefined, which causes the getter to return the default base value.
   */
  resetBase() {
    this._base = undefined;
  }

  /**
   * @returns {string} contentReference
   */
  get contentReference() { return this._contentReference; }
  /**
   * @param {string} contentReference
   */
  set contentReference(contentReference) { this._contentReference = contentReference; }

  /**
   * @returns {{code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}[]} type
   */
  get type() { return this._type; }
  /**
   * @param {{code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}[]} type
   */
  set type(type) { this._type = type; }

  // defaultValue[x] can be literally almost any field name (e.g., defaultValueCode, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  /**
   * @returns {string} meaningWhenMissing
   */
  get meaningWhenMissing() { return this._meaningWhenMissing; }
  /**
   * @param {string} meaningWhenMissing
   */
  set meaningWhenMissing(meaningWhenMissing) { this._meaningWhenMissing = meaningWhenMissing; }

  /**
   * @returns {string} orderMeaning
   */
  get orderMeaning() { return this._orderMeaning; }
  /**
   * @param {string} orderMeaning
   */
  set orderMeaning(orderMeaning) { this._orderMeaning = orderMeaning; }

  // fixed[x] can be literally almost any field name (e.g., fixedCode, fixedFoo, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  // pattern[x] can be literally almost any field name (e.g., patternCode, patternFoo, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  /**
   * @returns {Object[]} example
   */
  get example() { return this._example; }
  /**
   * @param {Object[]} example
   */
  set example(example) { this._example = example; }

  // minValue[x] can be many different field names (e.g., minValueDate, minValueQuantity, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  // maxValue[x] can be many different field names (e.g., maxValueDate, maxValueQuantity, etc.),
  // so we can't easily use a getter/setter.  It will be just a vanilla property.

  /**
   * @returns {number} maxLength
   */
  get maxLength() { return this._maxLength; }
  /**
   * @param {number} maxLength
   */
  set maxLength(maxLength) { this._maxLength = maxLength; }

  /**
   * @returns {string} condition
   */
  get condition() { return this._condition; }
  /**
   * @param {string} condition
   */
  set condition(condition) { this._condition = condition; }

  /**
   * @returns {{key: string, requirements?: string, severity: string, human: string, expression: string, xpath?: string, source?: string}[]} constraint
   */
  get constraint() { return this._constraint; }
  /**
   * @param {{key: string, requirements?: string, severity: string, human: string, expression: string, xpath?: string, source?: string}[]} constraint
   */
  set constraint(constraint) { this._constraint = constraint; }

  /**
   * @returns {boolean} mustSupport
   */
  get mustSupport() { return this._mustSupport; }
  /**
   * @param {boolean} mustSupport
   */
  set mustSupport(mustSupport) { this._mustSupport = mustSupport; }

  /**
   * @returns {boolean} isModifier
   */
  get isModifier() { return this._isModifier; }
  /**
   * @param {boolean} isModifier
   */
  set isModifier(isModifier) { this._isModifier = isModifier; }

  /**
   * @returns {boolean} isSummary
   */
  get isSummary() { return this._isSummary; }
  /**
   * @param {boolean} isSummary
   */
  set isSummary(isSummary) { this._isSummary = isSummary; }

  /**
   * @returns {{strength: string, description?: string, valueSetUri?: string, valueSetReference?: Object}} binding
   */
  get binding() { return this._binding; }
  /**
   * @param {{strength: string, description?: string, valueSetUri?: string, valueSetReference?: Object}} binding
   */
  set binding(binding) { this._binding = binding; }

  /**
   * @returns {{identity: string, language?: string, map: string, comment?: string}} mapping
   */
  get mapping() { return this._mapping; }
  /**
   * @param {{identity: string, language?: string, map: string, comment?: string}} mapping
   */
  set mapping(mapping) { this._mapping = mapping; }

  /**
   * @returns {StructureDefinition} structDef
   */
  get structDef() { return this._structDef; }
  /**
   * @param {StructureDefinition} structDef
   */
  set structDef(structDef) { this._structDef = structDef; }

  /**
   * Creates a new element with an id/path indicating it is a child of the current element.
   * Defaults to '$UNKNOWN' if no name is passed in, as it needs a value, but usually a name should be passed in.
   * NOTE: This function does not automatically add the child element to the StructureDefinition.
   * @param {string} name - the name of the child element, to be appended to the parent ID/path
   * @returns {ElementDefinition} the new child element
   */
  newChildElement(name='$UNKNOWN') {
    const el = new ElementDefinition(`${this.id}.${name}`);
    el.structDef = this.structDef;
    return el;
  }

  /**
   * ElementDefinition is capable of producing its own differential, based on differences from a stored "original".
   * This function captures the current state as the "original", so any further changes made would be captured in
   * the generated differential.
   */
  captureOriginal() {
    this._original = this.clone();
  }

  /**
   * Clears the stored "original" state, resulting in every property being considered new, and reflected in the
   * generated differential.
   */
  clearOriginal() {
    this._original = null;
  }

  /**
   * Determines if the state of the current element differs from the stored "original".
   * @returns {boolean} true if the state of the current element differs from the stored "original", false otherwise
   */
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

  /**
   * Calculates the differential based on changes in data from the stored "original" state and returns the differential
   * as a new ElementDefinition containing only the changed data.
   * @returns {ElementDefinition} an ElementDefinition representing the changed data since the stored "original" state
   */
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

  /**
   * Binds a value set with a specific strength to this element or to a child element.  If the target element is in a
   * deeper path than currently represented in the structure definition, parent level elements will be "expanded"
   * (or "unrolled") based on their definition.  This means that calling this function may result in increasing the
   * number of elements in the structure definition.
   * @param {string} vsURI - the value set URI to bind
   * @param {string} strength - the strength of the binding (e.g., 'required')
   * @param {string} [path] - if the binding should be applied to a child element, the dot-separated path of that element
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} [resolve] - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition} the element to which the value set was bound (may be a child of the current element)
   */
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

  /**
   * Fixes a code to this element or to a child element. If the element had a value set binding, it is removed.  If the
   * target element is in a deeper path than currently represented in the structure definition, parent level elements
   * will be "expanded" (or "unrolled") based on their definition.  This means that calling this function may result in
   * increasing the number of elements in the structure definition.
   * @param {{system: string, code: string, display: string}} code - the code to fix
   * @param {string} [path] - if the code should be fixed to a child element, the dot-separated path of that element
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} [resolve] - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition} the element to which the code was fixed (may be a child of the current element)
   */
  fixCode(code, path, resolve) {
    if (code.system == 'urn:tbd') {
      // Skip TBD codes
      return;
    }

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
        if (code.system) {
          coding.sliceIt('value', 'system');
        }
        coding.sliceIt('value', 'code');
        const slice = coding.newSlice(`Fixed_${code.code}`); // TODO: use symbolized version of display if it's there?
        if (code.display) {
          slice.short = slice.definition = common.trim(code.display);
        } else {
          slice.short = slice.definition = `Code: ${code.code}${code.system ? ' from ' + code.system : ''}`;
        }
        slice.fixCode(code, null, resolve);
      }
    } else if (this.type.some(t => t.code === 'Coding')) {
      const codingSystem = this.findChild('system', resolve);
      if (codingSystem) {
        if (code.system) {
          codingSystem.min = 1;
          // @ts-ignore
          codingSystem.fixedUri = code.system;
        } else {
          codingSystem.min = 0;
          codingSystem.max = '0';
          const codingVersion = this.findChild('version', resolve);
          if (codingVersion) {
            codingVersion.min = 0;
            codingVersion.max = '0';
          }
        }
      }
      const codingCode = this.findChild('code', resolve);
      if (codingCode) {
        codingCode.min = 1;
        codingCode.fixedCode = code.code;
      }
      if (code.display) {
        this.short = this.definition = common.trim(code.display);
      }
    } else if (this.type.some(t => t.code === 'code')) {
      this.fixedCode = code.code;
      if (code.display) {
        this.short = this.definition = common.trim(code.display);
      }
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

  /**
   * Fixes a code as a required element in a code list for this element or for a child element. This is done by slicing
   * the list and constraining a slice.  If the target element is in a deeper path than currently represented in the
   * structure definition, parent level elements will be "expanded" (or "unrolled") based on their definition.  This
   * means that calling this function may result in increasing the number of elements in the structure definition.
   * @param {{system: string, code: string, display: string}} code - the code to fix
   * @param {string} [path] - if the code should be fixed to a child element, the dot-separated path of that element
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} [resolve] - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition} the element representing the list in which a code was constrained (may be a child of
   *   the current element)
   */
  fixCodeInList(code, path, resolve) {
    if (code.system == 'urn:tbd') {
      // Skip TBD codes
      return;
    }

    // TODO: Add error checking such as if this is a list of code-ish elements.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    if (path && path.length > 0) {
      const child = this.findChild(path, resolve);
      if (child) {
        return child.fixCodeInList(code, null, resolve);
      }
      return;
    }

    // TODO: If the element isn't a list, should we slice higher?

    // This is the element to fix it to
    // This requires slicing. See: https://chat.fhir.org/#narrow/stream/implementers/subject/fixedUri
    if (this.type.some(t => t.code === 'CodeableConcept')) {
      this.sliceIt('value', 'coding');
    } else if (this.type.some(t => t.code === 'Coding')) {
      if (code.system) {
        this.sliceIt('value', 'system');
      }
      this.sliceIt('value', 'code');
    } else if (this.type.some(t => t.code === 'code')) {
      this.sliceIt('value', '$this');
    } else {
      // Not something we can fix a code on
    }

    const slice = this.newSlice(`Includes_${code.code}`);
    slice.min = 1;
    slice.max = '1';
    if (code.display) {
      slice.short = slice.definition = common.trim(code.display);
    } else {
      slice.short = slice.definition = `Code: ${code.code}${code.system ? ' from ' + code.system : ''}`;
    }
    slice.fixCode(code, null, resolve);

    // TODO: Consider keeping track of a fixed count on the element so you can increment this.min if necessary

    if (this.binding) {
      this.binding = undefined;
    }

    return this;
  }

  /**
   * Fixes a boolean value to the element or a child of the element indicated by the path.  If the target element is
   * in a deeper path than currently represented in the structure definition, parent level elements will be "expanded"
   * (or "unrolled") based on their definition.  This means that calling this function may result in increasing the
   * number of elements in the structure definition.
   * @param {boolean} value - the boolean value to fix
   * @param {string} [path] - if the boolean should be fixed to a child element, the dot-separated path of that element
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} [resolve] - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition} the element to which the boolean was fixed (may be a child of the current element)
   */
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

  /**
   * Modifies the cardinality of the element or a child of the element indicated by the path.  If the target element is
   * in a deeper path than currently represented in the structure definition, parent level elements will be "expanded"
   * (or "unrolled") based on their definition.  This means that calling this function may result in increasing the
   * number of elements in the structure definition.
   * @param {number} min - the minimum cardinality
   * @param {number|string} max - the maximum cardinality
   * @param {string} [path] - if the cardinality should be modified on a child element, the dot-separated path of that
   *   element
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} [resolve] - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition} the element on which to modify cardinality (may be a child of the current element)
   */
  modifyCard(min, max, path, resolve) {
    // TODO: Add error checking such as if the new card fits in the existing card.
    // But this is not needed now since these are used for standalone, "greenfield" models.
    if (path && path.length > 0) {
      const child = this.findChild(path, resolve);
      if (child) {
        return child.modifyCard(min, max, null, resolve);
      }
      return;
    }

    // This is the element to modify card on
    this.min = min;
    if (typeof max === 'string') {
      this.max = max;
    } else {
      this.max = (max == null) ? '*' : `${max}`;
    }

    return this;
  }

  /**
   * Finds and returns the parent element.  For example, the parent element of `Foo.bar.one` is the element `Foo.bar`.
   * @returns {ElementDefinition|undefined} the parent element or undefined if this is the root element
   */
  parent() {
    const parentId = this.id.split('.').slice(0, -1).join('.');
    if (parentId === '') {
      return;
    }
    return this.structDef.findElement(parentId);
  }

  /**
   * Finds and returns all child elements of this element.  For example, the children of `Foo.bar` might be the
   * elements `Foo.bar.one`, `Foo.bar.two`, and `Foo.bar.two.a`.  This will not "expand" or "unroll" elements; it
   * only returns those child elements that already exist in the structure definition.
   * @returns {ElementDefinition[]} the child elements of this element
   */
  children() {
    // TODO: this has a bug in that children of choice ([x]) elements won't be properly identified if the choice
    // was expanded.  Don't fix for now, however, as we need to tag this code as-is since it is what produced the
    // balloted logical models for the BreastCancer IG.
    return this.structDef.elements.filter(e => {
      return e !== this && e.id.startsWith(`${this.id}.`);
    });
  }

  /**
   * Finds a child element represented by a relative path to this element.  If the target element is in a deeper path
   * than currently represented in the structure definition, parent level elements will be "expanded" (or "unrolled")
   * based on their definition.  This means that calling this function may result in increasing the number of elements
   * in the structure definition.
   * @param {string} path - the dot-separated path of the child to find
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} [resolve] - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition|undefined} the child element represented by the path, or undefined if path is invalid
   */
  findChild(path, resolve = (arg) => null) {
    if (!path || path.length == 0) {
      return this;
    }

    // Re-usable function to check for a matching path w/ special support for looking at aliases.
    // This is needed because we rename specific types to 'value' or 'value[x]' when appropriate, but
    // sometimes those elements might be searched by the specific type name (instead of value/value[x]).
    const pathMatches = (element, base, tail) => {
      return element.path === `${base}.${tail}`
        || (element.path.lastIndexOf('.') === base.length && element.alias && element.alias.some(a => a === tail));
    };

    const [root, rest] = path.split('.', 2);
    const children = this.structDef.elements.filter(e => {
      return e.id.startsWith(this.id) && pathMatches(e, this.path, root);
    });
    if (children.length === 1) {
      // If it's a choice, we need to go further
      let child = children[0];
      if (child.type && child.type.length > 1) {
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
          this.unfold(resolve);
          return this.findChild(path, resolve);
        }
      }
    }
  }

  /**
   * If the element has a single type, graft the type's elements into this StructureDefinition as child elements.
   * @param {function({code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}):StructureDefinition} resolve - a function that can resolve a type to a StructureDefinition instance
   * @returns {ElementDefinition[]} the unfolded elements or an empty array if the type is multi-value or type can't
   *   be resolved.
   */
  unfold(resolve = (arg) => null) {
    if (this.type.length === 1) {
      const def = resolve(this.type[0]);
      if (def) {
        const newElements = def.elements.slice(1).map(e => {
          const eClone = e.clone();
          eClone.id = eClone.id.replace(def.type, `${this.id}`);
          eClone.structDef = this.structDef;
          return eClone;
        });
        this.structDef.addElements(newElements);
        return newElements;
      }
    }
    return [];
  }

  /**
   * Slices an element by adding or modifying the element's `slicing`.
   * @see {@link http://hl7.org/fhir/STU3/profiling.html#slicing|FHIR Profiles: Slicing}
   * @param {string} discriminatorType - the discriminator type ('value' | 'exists' | 'pattern' | 'type' | 'profile')
   * @param {string} discriminatorPath - the dot-separated discriminator path
   * @returns {{discriminator?: {type: string, path: string}[], description?: string, ordered?: boolean, rules: string}}
   *   the slicing
   */
  sliceIt(discriminatorType, discriminatorPath) {
    if (!this.slicing || !this._slicing.discriminator) {
      this.slicing = {
        discriminator : [{
          type: discriminatorType,
          path: discriminatorPath
        }],
        ordered : false,
        rules : 'open'
      };
    } else {
      if (!this.slicing.discriminator.some(d => d.type === discriminatorType && d.path === discriminatorPath)) {
        this.slicing.discriminator.push({ type: discriminatorType, path: discriminatorPath });
      }
    }

    return this.slicing;
  }

  /**
   * Gets a Map of the slices associated with this element, where the key is the slice name and the value is the
   * ElementDefinition representing the slice.  If there are no slices, it will return an empty Map.
   * @returns {Map<string,ElementDefinition>} the map containing this element's slices
   */
  getSliceMap() {
    const sliceMap = new Map();

    // Find all the slice roots, iterate them, and get their children
    let re = new RegExp(`^${escapeRegExp(this.id)}:[^\.]+$`);
    // TODO: For now we don't support choices that themselves are in a slice (e.g., assume choice id ends with [x])
    if (this.id.endsWith('[x]')) {
      re = new RegExp(`^${escapeRegExp(this.id.slice(0, -3))}[A-Z][^:\.]*:[^\.]+$`);
    }
    this.structDef.elements.filter(e => re.test(e.id)).forEach(e => {
      const name = e.sliceName;
      if (name == null) {
        // TODO: log an error
        return;
      }
      sliceMap.set(name, e);
    });

    return sliceMap;
  }

  /**
   * Replaces the the sliced element with a specific slice, removing all other slices.  If sliceNameToKeep is null or
   * undefined, it removes the discriminator from this element and removes all existing slices.  If this element is
   * not sliced, returns itself.
   * @param {string} sliceNameToKeep - the name of the slice to keep in place of this element
   * @returns {ElementDefinition} the remaining element after unslicing (usually corresponding to sliceNameToKeep)
   */
  unSliceIt(sliceNameToKeep) {
    if (!this.slicing) {
      return this;
    }

    // Remove all slices except the one matching sliceNameToKeep
    const sliceMap = this.getSliceMap();
    for (const name of sliceMap.keys()) {
      if (name !== sliceNameToKeep) {
        sliceMap.get(name).detach();
      }
    }

    // If sliceNameToKeep was named and exists, detach *this* slice and return kept slice
    if (sliceNameToKeep != null && sliceMap.has(sliceNameToKeep)) {
      this.detach();
      const keeper = sliceMap.get(sliceNameToKeep);
      const oldKeeperID = keeper.id;
      const keeperChildren = keeper.children();
      keeper.id = keeper.id.slice(0, keeper.id.lastIndexOf(':'));
      keeperChildren.forEach(c => c.id = c.id.replace(oldKeeperID, keeper.id));
      keeper.sliceName = undefined;
      return keeper;
    }

    // No slice to keep, so keep and return this instead
    this.slicing = undefined;
    return this;
  }

  /**
   *
   * @param {string} name - the name of the new slice
   * @param {{code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}} [type] - the type of the new slice; if undefined it copies over this element's types
   * @returns {ElementDefinition} the new element representing the slice
   */
  newSlice(name, type) {
    // TODO: Ensure that there is already a slicing
    const slice = new ElementDefinition();
    slice.structDef = this.structDef;
    if (type) {
      slice.id = `${this.id.replace(/\[x\]$/, common.capitalize(nameFromType(type)))}:${name}`;
      slice.type = [type];
    } else {
      slice.id = `${this.id}:${name}`;
      slice.type = cloneDeep(this.type);
    }
    slice.sliceName = name;
    slice.short = this.short ? this.short : name;
    slice.definition = this.definition ? this.definition : name;
    slice.min = this.min;
    slice.max = this.max;
    slice.base = cloneDeep(this.base);
    slice.mustSupport = this.mustSupport;
    slice.isModifier = this.isModifier;
    slice.isSummary = this.isSummary;
    // TODO: Remove unnecessary / extravagant properties?
    this.structDef.addElement(slice);
    return slice;
  }

  /**
   * Modifies this element from a choice (e.g., value[x]) to a specific type from the choice (e.g., valueString).  If
   * this choice has child elements, their ids and paths will be modified accordingly.
   * @param {string} [typeName] - the type to normalize this choice to. If undefined, uses the first type in this element.
   */
  normalizeChoice(typeName) {
    if (!this.path.endsWith('[x]')) {
      return;
    }
    typeName = typeName != null ? common.capitalize(typeName) : common.capitalize(this.type[0].code);
    const oldID = this.id;
    this.id = this.id.replace(/\[x\](:[^\.]+)?$/, typeName + '$1');
    this.children().forEach(c => c.id = c.id.replace(oldID, this.id));
  }

  /**
   * Removes this element, and optionally its children, from its StructureDefinition so it is no longer recognized as an
   * element of the StructureDefinition.
   * @param {boolean} [detachChildren=true] - indicates if this element's children should also be detached from the
   *   StructureDefinition
   * @returns {ElementDefinition[]} the array of ElementDefinitions that were detached from the StructureDefinition
   */
  detach(detachChildren=true) {
    const detached = [];
    const toDetach = [this];
    if (detachChildren) {
      // @ts-ignore
      toDetach.push(...this.children());
    }
    for (const el of toDetach) {
      const i = this.structDef.elements.findIndex(e => e === el);
      if (i !== -1) {
        detached.push(el);
        this.structDef.elements.splice(i, 1);
      }
    }
    return detached;
  }

  /**
   * Clones the current ElementDefinition, optionally clearing the stored "original" (clears it by default)
   * @param {boolean} [clearOriginal=true] - indicates if the stored "original" should be cleared
   * @returns {ElementDefinition} the cloned ElementDefinition
   */
  clone(clearOriginal=true) {
    // We don't want to clone the reference to the StructureDefinition, so temporarily save it and remove it
    const savedStructDef = this.structDef;
    this.structDef = null;
    const clone = cloneDeep(this);
    // The `base` is a special case since it is sometimes provided by a calculated property.
    // We want to freeze the base to the cloned object, so explicitly set it.
    clone.base = cloneDeep(this.base);
    // Set the reference to the StructureDefinition again
    this.structDef = clone.structDef = savedStructDef;
    // Clear original if applicable
    if (clearOriginal) {
      clone.clearOriginal();
    }
    return clone;
  }

  /**
   * Provides the FHIR-conformant JSON representation of this ElementDefinition
   * @returns {Object} the FHIR-conformant JSON representation of this ElementDefinition
   */
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

  /**
   * Instantiates a new ElementDefinition from a FHIR-conformant JSON representation
   * @param {Object} json - the FHIR-conformant JSON representation of the ElementDefinition to instantiate
   * @returns {ElementDefinition} the ElementDefinition representing the data passed in
   */
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

/**
 * Gets the name from a type.  If the type is a full URI, it returns only the last part of the URI.
 * @param {{code: string, profile?: string, targetProfile?: string, aggregation?: string[], versioning?: string}} type - the type to get the name from
 * @returns {string} the name extracted from the type
 */
function nameFromType(type) {
  const stringType = common.typeToString(type);
  // If it's a URI, then just return the last part
  return stringType.split('/').pop();
}

/**
 * The list of ElementDefinition properties used when importing/exporting FHIR JSON.
 */
const PROPS = [ 'id', 'extension', 'path', 'representation', 'sliceName', 'label', 'code',
  'slicing', 'short', 'definition', 'comment', 'requirements', 'alias', 'min', 'max', 'base',
  'contentReference', 'type', 'defaultValue[x]', 'meaningWhenMissing', 'orderMeaning', 'fixed[x]', 'pattern[x]',
  'example', 'minValue[x]', 'maxValue[x]', 'maxLength', 'condition', 'constraint', 'mustSupport', 'isModifier',
  'isSummary', 'binding', 'mapping' ];

module.exports = ElementDefinition;