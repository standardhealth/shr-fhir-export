# SHR HL7 FHIR Export

_NOTE: This is a Work-in-Progress.  It is NOT complete._

The Standard Health Record (SHR) Collaborative is working to create a single, high-quality health record for every individual in the United States.  For more information, see [standardhealthrecord.org](http://standardhealthrecord.org/).

This GitHub repository contains an ES6 library for exporting SHR data elements represented using SHR models as [HL7 FHIR STU3](http://hl7.org/fhir/STU3/index.html) profiles, extensions, value sets, code systems, and logical models.

The SHR text definitions and grammar files can be found in the [shr_spec](https://github.com/standardhealth/shr_spec) repo.  As the SHR text format (and content files) are still evolving, so is this library.

# Setting Up the Environment

1. Install [Node.js](https://nodejs.org/en/download/) (LTS edition, currently 8.x)
2. Install [Yarn](https://yarnpkg.com/en/docs/install) (1.3.x or above)
3. Execute the following from this project's root directory: `yarn`

# Running the Tests

This project contains *some* unit tests for testing the SHR FHIR exporter.  To run the tests, execute the following command:
```bash
$ yarn test
```

During development, it is often helpful to run tests in _watch_ mode.  This launches a process that watches the filesystem for changes to the javascript files and will automatically re-run the tests whenever it detects changes.  To run the tests in _watch_ mode, execute the following command:
```bash
$ yarn test:watch
```

## Regression Tests

This project contains regression tests that import spec files, export them to FHIR, and tests the results against an expected baseline.  These tests may take several seconds to complete.  To skip them, run:
```bash
$ yarn test:fast
```

The nature of these regression tests is that the baseline they test agains is _expected_ to change as features are added or bugs are fixed.  Failing tests don't necessarily mean that something is _broken_; they only mean that something has _changed_.  This ensures that changes are intentional.  If the regression tests fail because of an _intended_ change, then the regression fixtures should be updated to reflect that change.

Note that the current regression fixtures don't exercise all code paths / features.  They are, in fact, the specifications that were balloted as the HL7 FHIR US Breast Cancer IG in May 2018.

## Fixing Tests

The Model and Regression tests support a special "fix" mode that will update test fixtures with actual results.  This is particularly useful for regression tests when a new feature is added and the developer has determined that all regression failures are due to _intentional_ changes.  To run the auto fix:
```bash
$ yarn test:fix
```

# Linting the Code

To encourage quality and consistency within the code base, all code should pass eslint without any warnings.  Many text editors can be configured to automatically flag eslint violations.  We also provide an npm script for running eslint on the project.  To run eslint, execute the following command:
```
$ yarn lint
```

# License

Copyright 2016-208 The MITRE Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
