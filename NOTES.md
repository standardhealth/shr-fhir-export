# DSTU2 Support Notes

## Definitions
- added all FHIR JSON definitions
- added all Argonaut JSON definitions

## shr-extension-template
- changed "title" to "display"
- changed value of "kind" to "datatype"
- changed "type" to "constrainedType"
- changed baseDefinition to "base"
- removed "derivation"

## shr-valueSet-template.json
- removed "title"
- added "codeSystem"
- NOTE: Inline code systems are *in* the value set

## StructureDefinition
- DSTU2 didn't put ids on element fields, so we added them
- Loader: kind values changed (R3 primitive-type & complex-type, R2 datatype)
- SVH: R3 type, R2 constrainedType or first path
- SVH: R3 baseDefinition, R2 base
- SVH: R3 title, R2 display
- SVH: R3 keyword, R2 code

## ElementDefinition
- SVH: R3 sliceName, R2 name

## ValueSet
- MVH: R3 title, R2 name
