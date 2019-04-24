# StructureDefinition

* fhirVersion
    * STU3 is an `id`
    * R4 is a `code`
* context
    * STU3 has `contextType 0..1 code` and `context 0..* string`
    * R4 has `context 0..* BackboneElement` with `context.type 1..1 code` and `context.expression 1..1 string`
* type
    * STU3 is a `code`
    * R4 is a `uri`
* baseDefinition
    * STU3 is a `uri`
    * R4 is a `canonical`

# ElementDefinition

* invariants
    * Types must be unique by `code`
    * Must have a `modifierReason` if `isModifier = true`
* sliceIsContraining
    * R4 adds `sliceIsConstraining` element
* type
    * STU3 has `profile 0..1 uri` and `targetProfile 0..1 uri`
    * R4 has `profile 0..* canonical` and `targetProfile 0..* canonical`
* constraint
    * STU3 has `expression 1..1 string` and `source 0..1 uri`
    * R4 has `expression 0..1 string` w/ invariant and `source 0..1 canonical`
* isModifierReason
    * R4 adds `isModifierReason` which must be present if `isModifier = true`
* binding
    * STU3 has `valueSet[x]`, allowing for `uri` or `Reference`
    * R4 has `valueSet` which is a `canonical`

# CodeSystem

* identifier
    * STU3 `identifier` is `0.1`
    * R4 `identifier` is `0.*`

# ImplementationGuide

* lots of changes -- see: http://hl7.org/fhir/R4/implementationguide.html#tabs-diff