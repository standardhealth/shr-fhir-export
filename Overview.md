# SHR FHIR Export

The following document provides a high-level (but likely incomplete) overview of how the SHR FHIR export processes work.  Please note that previous processes convert CAMEO definitions and mappings into in-memory models.  Those processes are not discussed here.

To export FHIR 3.0.1 profiles and extensions, the exporter must have the core FHIR 3.0.1 definitions.  To support this, the FHIR exporter maintains a copy of the [JSON FHIR definitions](http://hl7.org/fhir/definitions.json.zip) in a local folder.  These definitions form the basis from which all profiles are derived.

The FHIR exporter code is actually a set of four different, but related, exporters:
* FHIR Profile Exporter
* FHIR Extension Exporter
* FHIR Value Set Exporter
* FHIR Code System Exporter

The export process follows this basic sequence:
1. Export all defined code systems
2. Export all defined value sets
3. Export all Entries as profiles
   * Export extensions as/when they are needed
   * Export referenced profiles as/when they are needed

# FHIR Code System Exporter

CAMEO does not have explicit support for defining code systems.  Code system definitions are inferred from Value Set definitions that introduce new internal codes.  For example:
```
ValueSet:    ThreeValueLogicVS
#true        "True, or yes"
#false       "False, or no"
#unknown     "Unknown"
```
The above _value set_ definition results in an inferred code system definition called `ThreeValueLogicCS`, with URL http://standardhealthrecord.org/shr/code/cs/ThreeValueLogicCS, and containing three codes: `true`, `false`, and `unknown`.  This is the information that is passed to the code system exporter.

The code system exporter implementation is rather simple.  For each code system:
1. Load the pre-defined code system template, containing a stubbed out JSON FHIR `CodeSystem` resource instance
2. Set `id` to the generated id
3. Set `text.div` to the generated narrative
4. Set `url` to the code system URL
5. Set `name` and `title` to the code system's name
6. Set `date` to the current timestamp
7. Set `description` to the code system's description (if applicable)
8. Set `count` to the number of codes in the code system
9. For each code in the code system:
   * Create an object with a `code` property set to the code
   * If the code has display text, assign it to the object's `display` and `definition` properties
   * Add the new object to the code system definition's `codes` array

# FHIR Value Set Exporter

CAMEO supports defining value sets using a set of specific codes, or rules that describe a set of codes (e.g., `Includes codes descending from SCT#64572001 "disease"`).  This makes the value set exporter only slightly more complicated than the code system exporter.

The value set exporter implementation is still fairly simple.  For each value set:
1. Load the pre-defined value set template, containing a stubbed out JSON FHIR `ValueSet` resource instance
2. Set `id` to the generated id
3. Set `text.div` to the generated narrative
4. Set `url` to the value set URL
5. Set `name` and `title` to the value set's name
6. Set `date` to the current timestamp
7. Set `description` to the value set's description (if applicable)
9. For each value set inclusion/exclusion rule used in the value set:
   * Create an object with the appropriate `system` and (if applicable) `filter` property values
   * Add the new object to the value set definition's `compose.include` or `compose.exclude` array
10. For each code that was specifically defined in the value set:
    * Search for `compose.include` objects with the matching `system` and a defined `concept` array
    * If the previous search yields no results, create a new object with the appropriate `system` property and an empty `concept` array, and append it to the `compose.include` array
    * Create a new object with a `code` property set to the code
    * If the code has display text, assign it to the object's `display` property
    * Add the new object to the matching inclusion object in `compose.include`.

# FHIR Profile Exporter

CAMEO supports defining profiles via the combination of element definitions and mappings.  CAMEO allows authors to flag elements as _entries_.  This indicates that those elements can stand alone as a separate entry in a person's health record.  Elements that are _not_ flagged as entries are intended to be used only in the composition of other elements.  Every _entry_ is exported to a profile, but non-entry elements are only exported as a profile when necessary.

The profile exporter is the most complex FHIR exporter.  This documentation will provide a high-level overview, but much of the complexity is in the details of the implementation.

## Mapping Definitions

A mapping definition identifies a source element, a target resource, and a set of mapping rules.  There are four general types of mapping rules:
* **Field to Field**: maps a field in the source element to a property in the target resource
* **Field to URL**: maps a field to an extension URL
* **Cardinality**: narrows the cardinality of a property in the target resource (when there is no corresponding source element)
* **Fixed Value**: fixes the value of a target resource (when there is no corresponding source element)

The majority of mapping rules are _Field to Field_ rules.  The following is an example of a mapping that uses _Field to Field_ and _Field to URL_ rules:
```
PersonOfRecord maps to Patient:
	HumanName maps to name
	DateOfBirth maps to birthDate
	MultipleBirth maps to multipleBirth[x].boolean
	MultipleBirth.MultipleBirthOrder maps to multipleBirth[x].integer
	BirthSex maps to http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex
	PlaceOfBirth maps to http://hl7.org/fhir/StructureDefinition/birthPlace
	AdministrativeGender maps to gender
	Race maps to http://hl7.org/fhir/us/core/StructureDefinition/us-core-race
	Ethnicity maps to http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity
	MaritalStatus maps to maritalStatus
	MothersMaidenName maps to http://hl7.org/fhir/StructureDefinition/patient-mothersMaidenName
	AddressUsed maps to address
	Telecom maps to telecom
	LanguageUsed maps to communication
	Deceased maps to deceased[x].boolean
	MedicalInterpreterNeeded maps to http://hl7.org/fhir/StructureDefinition/patient-interpreterRequired
```

## Preprocessing Elements

Prior to invoking the FHIR exporters, another SHR software module (_shr-expand_) iterates over all elements and mappings to create the most explicit mapping definitions possible.  This process detects any mappings that should be inherited by an element and merges them into a single mapping definition for that element (along with any specific mappings already defined for it).  This process allows for child elements to be mapped to FHIR _implicitly_.  For example, if a `Procedure` mapping is already defined, then specific procedures, such as `CABG`, may not need any additional mapping defined.  The `shr-expand` process will create a specific `CABG` mapping based on the inherited `Procedure` mapping.  Note that this happens _before_ the FHIR exporters are invoked; the FHIR exporters do not do this inheritance expansion themselves.

When the FHIR profile exporter is invoked, it iterates over all of the _entry_ elements to determine if any entries still have no FHIR mapping defined.  For each entry that has no mapping definition, it will create a general mapping to the `Basic` resource.  In this way, all entries are guaranteed to have _some_ basis for a profile.

## Processing Elements

The FHIR profile exporter then iterates over every defined element (not just entries), and looks for a corresponding mapping for each one.  If a mapping is found, it checks to see if a profile has already been generated for it (i.e., if a previous profile referenced that element, causing it to be generated on-the-fly).  If a profile has not yet been generated, it generates the new profile.  If the profile was already generated, or there was no mapping found, the exporter moves on to the next mapping in the iteration.

## Generating a Profile

The first step in generating a profile for a given element is _enhancing_ the existing mapping.  CAMEO aims to allow authors to be as concise as possible.  To support efficient processing, however, the profile exporter prefers rules to be as explicit as possible.  The process of _enhancing_ the mapping adds these implicit directives to aid the exporter.  Note that this is different than the _shr-expand_ process above; whereas _shr-expand_ is a general process that applies to all types of mappings and mapping targets, the map enhancement discussed here is very specific to the the FHIR mapping implementation.

### Enhancing "Includes" Mapping Rules

One type of enhancement that is needed is to generate explicit mappings and slicing directives for element fields that are an array of a certain type, but indicate specific sub-types that should be included in that array.  For example, consider the following element:
```
EntryElement:   BreastCancerGeneticAnalysis
Based on:       Panel
PanelMembers.Observation
  includes 1..1   ref(BRCA1Variant)
  includes 1..1   ref(BRCA2Variant)
```
The field of interest for this example is the `PanelMembers.Observation` field.  This inherits the following mapping rule from a parent:
```
PanelMembers.Observation maps to related.target (slice at = related; slice on = target.reference.resolve(); slice on type = profile; slice strategy = includes)
```
Since this will result in several elements in the profile's structure definition, however, it's easier for the exporter to have the rule expanded to a series of more explicit rules (which is exactly what mapping enhancement does):
```
PanelMembers.Observation maps to related.target
PanelMembers.BRCA1Variant maps to related.target (slice at = related; slice on = target.reference.resolve(); slice on type = profile)
PanelMembers.BRCA2Variant maps to related.target (slice at = related; slice on = target.reference.resolve(); slice on type = profile)
```

### Enhancing Slicing Mapping Rules

Another type of enhancement also has to do with slicing (after all, slicing is one of the most complex aspects of FHIR).  When multiple elements map to the same target property, a slice must be used to distinguish them.  In CAMEO, you only need to declare the slicing directive once, as in the example below:
```
BodySite maps to BodySite:
	Value maps to code
	Laterality maps to qualifier (slice on = coding.code)
	Directionality maps to qualifier
	PortionTotality	maps to qualifier
	Description maps to description
```
The mapping enhancement process then analyzes the slicing directive, generates names for each slice, and rewrites the mapping rules to contain all of the necessary information:
```
BodySite maps to BodySite:
	Value maps to code
	Laterality maps to qualifier (slice on = coding.code; in slice = qualifier[shr-core-Laterality])
  Directionality maps to qualifier (slice on = coding.code; in slice = qualifier[shr-core-Directionality])
  PortionTotality maps to qualifier (slice on = coding.code; in slice = qualifier[shr-core-PortionTotality])
	Directionality maps to qualifier
	PortionTotality	maps to qualifier
	Description maps to description
```

### Enhancing the Order of Mapping Rules

The final type of enhancement modifies the order of the mapping rules based on the types and targets of the rules:
* _Cardinality_ and _Fixed Value_ rules should be applied first.  This is because _Field to Field_ mapping rules must be applied on top of them (especially since some rules will duplicate structure definition elements for slicing).
* Parent targets should be processed before child targets to ensure that all aggregate cardinalities are processed correctly (aggregate cardinalities are explained elsewhere).

### Applying Profile Metadata

After mapping enhancement is completed, the real profile generation begins.  The first step is to get the JSON FHIR definition for the resource that is the target of the mapping.  This is retrieved from the local folder containing all JSON FHIR definitions.  The definition is cloned so that the profile starts with the same properties and snapshot elements as the resource it is based on.  Then the following modifications are made to the clone:
1. Delete the `meta` and `extension` properties since they are not needed or relevant to this profile
2. Set `id` to the generated profile id
3. Set `text` to the generated narrative
4. Set `url` to the generated URL
5. Set `identifier` to an SHR-specific identifer
6. Set `name` to the profile name
7. Set `description` to the profile description (if applicable)
8. Set `publisher` and `contact` to hard-coded SHR information
9. Set `date` to the current timestamp
10. Set `baseDefinition` to the target resource's URL
11. Set `derivation` to `constraint`
12. For each element in `snapshot.element`:
    * Update `id` to append `:${profileID}` to the target resource name at the root of the path (e.g., `Patient.meta` becomes `Patient:shr-demographics-PersonOfRecord.meta`, etc.)
13. Set `snapshot.element[0].short` to the profile name
14. Set `snapshot.element[0].definition` to the profile description
15. Set `differential` to a new object with an `element` property containing a root element with the following properties, each initialized to the corresponding values from the root snapshot element: `id`, `path`, `short`, `definition`, `mustSupport`, `isModifier`, `isSummary`

### Applying Mapping Rules

After setting the basic profile metadata, it's time to iterate over the rules and apply each one.  For _Cardinality_, _Fixed Value_, and _Field to Field_ rules, the first steps are always the same.  Consider the following rule from SHR's `PersonOfRecord` mapping to FHIR's `Patient`:
```
HumanName maps to name
```
When applying this rule, first find the snapshot element pertaining to the target property.  In the example above, this is the snapshot element with id: `Patient:shr-demographics-PersonOfRecord.name`.

Then find the corresponding element in the `differential` using the snapshot element's `id`.  If no differential element is found, create a new one with the same `id` and `path` as the snapshot element.

While finding the snapshot element is often simple, there are more complex use cases such as when you need to find the snapshot element pertaining to a particular _slice_ of something.

### Applying Cardinality Rules

A cardinality rule indicates that a specific property in the target resource should be constrained to a specific cardinality.  For example, the mapping from SHR's `MedicationUse` to FHIR's `MedicationStatement` contains the following rule:
```
constrain dosage to 0..1
```
After finding the corresponding snapshot element, inspect the snapshot element's declared cardinality.  If the cardinality in the mapping rule is _narrower_ than the cardinality in the snapshot element, then set the new cardinality on both the _snapshot_ and _differential_ element.  If the cardinality is wider than the existing cardinality, however, this is an invalid mapping; log an error and do not modify the snapshot or differential elements.

### Applying Fixed Value Rules

A fixed value rule indicates that a specific property in the target resource should be fixed to a specific value.  For example, the mapping from SHR's `Observation` to FHIR's `Observation` contains the following rule:
```
fix related.type to #has-member
```
After finding the corresponding snapshot element, verify that the fixed value is of the same type as the target property.  If so,  fix the value on the corresponding _snapshot_ and _differential_ element.  If not, log an error and do not modify the snapshot or differential elements.

Currently, CAMEO only supports fixing code values, but future versions should support fixing any type of value.

### Applying Field to Field Rules

A field to field rule maps a specific field in an SHR element to a specific property in the target FHIR resource.  This is the most complex mapping rule to process as it requires mapping cardinalities, types, and constraints.  For example, the (inherited) mapping from SHR's `FoodAllergy` to FHIR's `AllergyIntolerance` contains the following rule:
```
SubstanceCategory maps to category
```
The `FoodAllergy.SubstanceCategory` field definition differs from FHIR's `AllergyIntolerance.category` property in that:
* it has cardinality `1..1` instead of `0..*`
* it is constrained to the code: `food`

After finding the corresponding snapshot element, it is inspected to determine if it is a _content reference_.  A _content reference_ is a pointer to a previously defined snapshot element in the same structure definition.  If the snapshot element is a _content reference_, then it must be materialized (or _unrolled_) to its full definition before applying any constraints.  This may result in several elements, all of which must be inserted into the snapshot/differential collections in place of the original element.

Note that when a field to field mapping rule contains slicing directives, the exporter creates the slice root and necessary slices as part of the process of getting the snapshot element.  In these cases, the corresponding sliced element is returned.

### Processing Field to Field Cardinality

Before applying type constraints, the cardinality of the source element field is compared to the cardinality of the target resource property.  This can be tricky, especially when the source element field and/or target resource property is nested several levels deep.  For example, consider the hypothetical field to field mapping:
```
A.B.C maps to x
```
If `A` is `0..1`, `B` is `1..3`, and `C` is `0..5`, then what is the cardinality that should be applied to the target `x`?  Our implementation calculates what it calls an _aggregate cardinality_ by determining the lowest possible low and highest possible high of chaining the cardinalities together.  In the example above, `C` may appear 0 to 15 times total (if there is 1 `A` with 3 `B`s, each having 5 `C`s, then there are 15 `C`'s total).  If the target is a nested path (e.g., `x.y.z`), then a similar approach is needed to determine the aggregate target cardinality.

After determining the cardinalities of the source and target (considering aggregate cardinalities if necessary), the exporter determines if the source cardinality fits within the target cardinality.  If not, an error is logged and no cardinality constraint is applied.

If the source cardinality fits within the target cardinality, the exporter must then determine how to adjust the target cardinality to match the source cardinality.  In cases where the target field is not nested, this is simple.  In cases where the target field is nested (e.g., `x.y.z`), the cardinality applied to the last element (e.g., `z`) is not necessarily the same as the source cardinality.  The right cardinality must be applied such that the _aggregate_ cardinality of the target matches the desired source cardinality.  In some cases, mapping authors may have to explicitly constrain cardinalities of parent properties in a nested target path in order to resolve ambiguity regarding how to reach the desired aggregate cardinality for that path.

If a valid target cardinality is determined, set the necessary cardinality on both the _snapshot_ and _differential_ element and move on to the next step in applying the field to field mapping.

### Processing Field to Field Type Constraints

After applying the necessary cardinality constraints, the exporter inspects the snapshot element to determine if there is a type that can be constrained by the source field that is mapped to it.  For example, if the source field is a `boolean`, then the target property must include a `boolean` type.  If the source field is a complex element, then the target propery must contain a type that can be constrained to the field's profile (e.g., a `HeartRate` field requires a property having an `Observation` type or a reference type to an `Observation`).

_\[NOTE: The previous statement is not entirely true for source fields that have a Value declared in their element definition.  If the field can't be mapped directly to the target property's type, then the exporter will try to map the field's Value instead.  In the example of the `HeartRate` field above, if the target property has a `Quantity` type, this also satisfies the mapping, since `HeartRate`'s Value is a `Quantity`.  It should be noted, however, that when this happens (the field Value is mapped instead of the field itself), then the rest of the field's own fields are not represented in the profile.  This is a known issue that won't be discussed further in this document.\]_

If a valid matching type is found, then that type object is modified in the snapshot/differential elements to indicate the source field's profile (if applicable). It is also possible for the source field and/or the target property to be a _choice_.  In these cases, the exporter will attempt to match each type in the source field choice to a valid type in the target property choice.

After constraining the type, any applicable constraints from the source field definition are applied to the target property.  This may include:
* constraining a code to a specific value set
* fixing a code to a specific code value
* indicating that an array of codes must included a specific code value
* fixing a boolean to a specific value

When applying these constraints, the exporter verifies that the constraints can be validly applied.  For example, if a source field tries to override a target value constraint that has a `REQUIRED` binding strength, the exporter will log an error and not apply the constraint.

Sometimes a field is defined with child constraints on nested fields (i.e., constraints not on the field itself, but rather on one of its own sub-fields).  In these cases, the snapshot and differential elements representing the target property may have to be "unrolled" to expose the child element to which the constraint should be applied.

### Applying Field to URL Rules

A field to URL rule maps a specific field in an SHR element to an existing extension in the target FHIR resource.  For example, the mapping from SHR's `PersonOfRecord` to FHIR's `Patient` contains the following rule:
```
Race maps to http://hl7.org/fhir/us/core/StructureDefinition/us-core-race
```
In this case, there is not a corresponding snapshot element to find.  Instead, a new extension element should be created and added to the _snapshot_ and _differential_ element collections.  The process of creating an extension element is described below, so will not be repeated here.

### Adding Extensions to the Profile

After processing all of the mapping rules, the exporter iterates the fields of the source element's defintion, looking for fields that were not mapped to target properties.  If any unmapped fields are found, the exporter gets (or creates) an extension definition for the field element and adds the extension declaration to the target profile.

To add an extension to a profile definition, the profile exporter follows the steps below:
1. Determine if the extension is a `modifierExtension`.  This is currently determined by a convention: modifiers have the word _modifier_ in their name (e.g., `NonOccurrenceModifier`).  Future versions should have a more specific approach to this.
2. Find and clone the root `extension` or `modifierExtension` element in the profile's snapshot elements
3. Append `:${fieldNameID}` to the `id` (e.g., `Patient:shr-demographics-PersonOfRecord.extension:passportnumber`)
4. Delete the `short` and `comments` properties
5. Set `sliceName` to the field name ID (e.g., `passportnumber`)
6. Set `definition` to the field's description
7. Set `min` and `max` to reflect the field's cardinality
8. Set `type` to have a `code` property value of `Extension` and `profile` property value of the extension URL
9. Set `mustSupport` and `isModifier` to `true` if it is a modifier extension
10. Set `isSummary` to `false`
11. Create a _differential_ element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `sliceName`, `min`, `max`, `type`, `mustSupport`, `isModifier`, `isSummary`
12. Apply any constraints (if applicable) to the extension snapshot and differential elements

After creating the snapshot and differential elements referencing the extension, add them in the correct spot in the snapshot and differential collections in the profile.

### Fixing the Code on Basic Profiles

Next, the profile exporter determines if the profile is based on the `Basic` resource.  If so, the profile exporter will:
1. Find the snapshot element for the `code` property
2. If the snapshot already contains a fixed code, do not fix the code again
3. Find the corresponding differential snapshot
4. Set the `patternCodeableConcept` on the snapshot and differential elements to `CodeableConcept` with:
   * `system` set to `http://standardhealthrecord.org/fhir/basic-resource-type`
   * `code` set to the profile's ID

### Constraining Out Unused Choices

Next the profile exporter will iterate over the profile, inspecting all _choice_ fields (those that end with _[x]_ or have multiple types defined).  For each choice field, if it contains types that have been profiled (indicating that they were mapped), the exporter will _removed_ any remaining _unprofiled_ types.  This ensures a stronger alignment between the SHR definition and the corresponding FHIR profile.

### Adding Intermediate Differential Paths for FHIR IG Publisher

The FHIR IG publisher does not handle missing intermediate paths well.  For example, if the profile has a differential element with the path `Observation.related.type`, but does _not_ have a differential element with the parent path, `Observation.related`, the FHIR IG publisher will not render the differential table correctly.

To address this limitation in the FHIR IG Publisher, the profile exporter first sorts all differential elements based on the original order of the snapshot elements.  It then detects any missing intermediate paths and adds new differential elements containing just the corresponding `id` and `path` for each of them.

After this, the profile generation is complete!

# FHIR Extension Exporter

CAMEO does not support an explicit syntax for creating FHIR extensions.  Instead, extensions are created as necessary during the definition of FHIR profiles.  For example, if an SHR element contains a field that cannot be mapped to a specific property in the target FHIR resource, an extension will be created to represent that field.

The extension exporter performs the following steps to export an extension:
1. Load the pre-defined extension template, containing a stubbed out JSON FHIR `StructureDefinition` resource instance
2. Set `id` to the generated id
3. Set `text.div` to the generated narrative
4. Set `url` to the extension URL
5. Set `identifier` to an SHR-specific identifer
6. Set `name` and `title` to the extension's name
7. Set `date` to the current timestamp
8. Set `description` to the extension's description (if applicable)
9. Create and add the base snapshot element with the following properties:
   * `id` set to `Extension:${shortID}` (e.g., `Extension:passportnumber`)
   * `path` set to `Extension`
   * `short` set to the element name
   * `definition` set to the element description (if applicable)
   * remaining properties set as in all extension base elements (see FHIR examples)
10. Create and add the base differential element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `short`, `definition`, `min`, `max`
11. Create and add the Extension.id snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.id` (e.g., `Extension:passportnumber.id`)
   * `path` set to `Extension.id`
   * remaining properties set as in all _Extension.id_ elements (see FHIR examples)

The next steps depend on if the SHR element can be represented using a simple extension (e.g., an extension that uses the `value[x]` snapshot element), or if it requires a complex extension (e.g., an extension that uses sub-extensions).

## Simple Extensions

If the SHR element is mapped to a FHIR profile, or if it declares only a _Value_ with no other fields, it can be exported as a simple extension using the `value[x]` snapshot element.  In this case, the extension exporter will perform the following additional steps:
1. Create and add the Extension.extension snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.extension`
   * `path` set to `Extension.extension`
   * `min` set to `0`
   * `max` set to `'0'` (to indicate that sub-extensions are not allowed)
   * remaining properties set as in all Extension.extension elements for simple extensions (see FHIR examples)
2. Create and add the Extension.extension differential element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `sliceName`, `max`
3. Create and add the Extension.url snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.url`
   * `path` set to `Extension.url`
   * `fixedUri` set to the extension URL
   * remaining properties set as in all Extension.url elements (see FHIR examples)
4. Create and add the Extension.url differential element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `type`, `fixedUri`
5. Create and add the Extension.value[x] snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.value${type}` (e.g., `Extension:administrativegender.valueCode`)
   * `path` set to `Extension.value${type}` (e.g., `Extension.value[x]`)
   * `min` and `max` set to the relevant cardinality (usually `0..1`)
   * `type` set to an array with an object containing appropriate `code`, `profile`, and/or `targetProfile` properties and constraints to reference the corresponding SHR profile
   * remaining properties set as in all Extension.value[x] elements for simple extensions (see FHIR examples)
6. Create and add the Extension.value[x] differential element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `min`, `type`

# Complex Extensions

If the SHR element is not mapped to a profile, and contains more than just a _Value_, it will need to be exported as a complex extension using sub-extensions.   In this case, the extension exporter will perform the following additional steps:
1. Create and add the Extension.extension snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.extension`
   * `path` set to `Extension.extension`
   * `slicing` set to an object with a unique `id`, a `discriminator` array containing a discriminator with `type`: `value` and `path`: `url`, an `ordered` property set to `false`, and a `rules` property set to `open`.
   * remaining properties set as in all Extension.extension elements for complex extensions (see FHIR examples)
2. For each field in the SHR element, find or create the corresponding sub-extension definition, then create and add an Extension.extension snapshot element slice with the following properties:
   * `id` set to `Extension:${elementShortID}.extension:${fieldShortID}` (e.g., `Extension:passportnumber.extension:countryofissue`)
   * `path` set to `Extension.extension`
   * `sliceName` set to the field name ID (e.g., `countryofissue`)
   * `short` and `definition` set to the sub-extension's `short` and `definition` values
   * `min` and `max` set to the field's cardinality
   * `type` set to an array containing an object with `code`: `Extension` and `profile` set to the sub-extension's URL
   * `isModifier` set to `true` if the element name contains the word _modifier_
   * remaining properties set as in all Extension.extension elements for sub-extensions (see FHIR examples)
3. Create and add the Extension.extension differential element slice with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `sliceName`, `short`, `definition`, `min`, `max`, `type`
4. Create and add the Extension.url snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.url`
   * `path` set to `Extension.url`
   * `fixedUri` set to the extension URL
   * remaining properties set as in all Extension.url elements (see FHIR examples)
5. Create and add the Extension.url differential element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `type`, `fixedUri`
6. Create and add the Extension.value[x] snapshot element with the following properties:
   * `id` set to `Extension:${shortID}.value[x]`
   * `path` set to `Extension.value[x]`
   * `min` set to `0`
   * `max` set to `'0'` (to indicate that `value[x]` is not allowed)
   * remaining properties set as in all Extension.value[x] elements for complex extensions (see FHIR examples)
7. Create and add the Extension.value[x] differential element with the following properties, each initialized to the corresponding values from the snapshot element: `id`, `path`, `min`, `max`