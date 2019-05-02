# StructureDefinition

* NO CHANGE - fhirVersion
    * STU3 is an `id`
    * R4 is a `code`
* NOT USED - context
    * STU3 has `contextType 0..1 code` and `context 0..* string`
    * R4 has `context 0..* BackboneElement` with `context.type 1..1 code` and `context.expression 1..1 string`
* NO CHANGE - type
    * STU3 is a `code`
    * R4 is a `uri`
* NO CHANGE - baseDefinition
    * STU3 is a `uri`
    * R4 is a `canonical` (but doesn't use versions)

# ElementDefinition

* POTENTIAL - invariants
    * Types must be unique by `code`
* POTENTIAL - sliceIsContraining
    * R4 adds `sliceIsConstraining` element
* DONE - type
    * STU3 has `profile 0..1 uri` and `targetProfile 0..1 uri`
    * R4 has `profile 0..* canonical` and `targetProfile 0..* canonical`
* NO CHANGE - constraint
    * STU3 has `expression 1..1 string` and `source 0..1 uri`
    * R4 has `expression 0..1 string` w/ invariant and `source 0..1 canonical`
* DONE - isModifierReason
    * R4 adds `isModifierReason` which must be present if `isModifier = true`
* NEEDS CHANGE - binding
    * STU3 has `valueSet[x]`, allowing for `uri` or `Reference`
    * R4 has `valueSet` which is a `canonical` (and does use versions)

# CodeSystem

* NEEDS CHANGE - identifier
    * STU3 `identifier` is `0.1`
    * R4 `identifier` is `0.*`

# ImplementationGuide

* lots of changes -- see: http://hl7.org/fhir/R4/implementationguide.html#tabs-diff

TO DOWNLOAD LATEST PUBLISHER: wget "http://oss.sonatype.org/service/local/artifact/maven/content?r=snapshots&g=org.hl7.fhir.publisher&a=org.hl7.fhir.publisher.cli&v=LATEST" --content-disposition
