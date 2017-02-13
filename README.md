# SHR HL7 FHIR Profile Export

_NOTE: This is a Work-in-Progress.  It is NOT complete._

The Standard Health Record (SHR) Collaborative is working to create a single, high-quality health record for every individual in the United States.  For more information, see [standardhealthrecord.org](http://standardhealthrecord.org/).

This GitHub repository contains an ES6 library for exporting SHR data elements represented using SHR models as [HL7 FHIR STU3](http://hl7.org/fhir/2017Jan/index.html) profiles.

The SHR text definitions and grammar files can be found in the [shr_spec](https://github.com/standardhealth/shr_spec) repo.  As the SHR text format (and content files) are still evolving, so is this library.

# Setting Up the Environment

This project has been developed and tested with Node.js 6.6, although other versions _may_ work.  After installing Node.js, change to the project directory and _npm install_ the dependencies:
```
$ npm install
```

# Running the Tests

This project contains unit tests for testing the SHR FHIR Profile exporter.  To run the tests, execute the following command:
```
$ npm test
```

During development, it is often helpful to run tests in _watch_ mode.  This launches a process that watches the filesystem for changes to the javascript files and will automatically re-run the tests whenever it detects changes.  To run the tests in _watch_ mode, execute the following command:
```
$ npm run test:watch
```

# Linting the Code

To encourage quality and consistency within the code base, all code should pass eslint without any warnings.  Many text editors can be configured to automatically flag eslint violations.  We also provide an npm script for running eslint on the project.  To run eslint, execute the following command:
```
$ npm run lint
```

# License

Copyright 2016 The MITRE Corporation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
