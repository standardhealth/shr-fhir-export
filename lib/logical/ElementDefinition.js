const cloneDeep = require('lodash/cloneDeep');

class ElementDefinition {
  constructor(id='') {
    this.id = id;
  }

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

  toJSON() {
    const j = {};
    for (const prop of ElementDefinition._PROPS) {
      if (this[prop] !== undefined) {
        j[prop.slice(1)] = cloneDeep(this[prop]);
      }
    }
    return j;
  }
}

ElementDefinition._PROPS = [ '_id', '_extension', '_path', '_representation', '_sliceName', '_label', '_code',
  '_slicing', '_short', '_definition', '_comment', '_requirements', '_alias', '_min', '_max', '_base',
  '_contentReference', '_type', '_defaultValue', '_meaningWhenMissing', '_orderMeaning', '_fixed', '_pattern',
  '_example', '_minValue', '_maxValue', '_maxLength', '_condition', '_constraint', '_mustSupport', '_isModifier',
  '_isSummary', '_binding', '_mapping' ];

module.exports = ElementDefinition;