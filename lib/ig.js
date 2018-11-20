const path = require('path');
const fs = require('fs-extra');
const common = require('./common');
const load = require('./load');
const MVH = require('./multiVersionHelper');

function exportIG(specifications, fhirResults, outDir, configuration = {}, specPath) {

  const config = configuration;

  // Load the FHIR definitions
  const target = common.getTarget(configuration, specifications);
  const fhir = load(target);

  // Copy the static parts of the IG
  fs.copySync(path.join(__dirname, 'ig_files'), outDir);

  const igControlPath = path.join(outDir, 'ig.json');
  const igControl = fs.readJsonSync(igControlPath);
  const primaryExtensionUrls = new Set();
  const localValueSetUrls = new Set();
  const primaryLocalValueSetUrls = new Set();
  const externalValueSetUrls = new Set();
  const primaryExternalValueSetUrls = new Set();
  const primaryCodeSystemUrls = new Set();
  const xmlResources = [];
  const htmlPrimaryProfiles = [];
  const htmlSupportProfiles = [];
  const htmlExtensions = [];
  const htmlLocalValueSets = [];
  const htmlExternalValueSets = [];
  const htmlCodeSystems = [];
  const htmlPrimaryModels = [];
  const htmlSupportModels = [];

  // Update igControl version and dependency list if applicable
  if (target === 'FHIR_DSTU_2') {
    igControl.version = '1.0.2';
    igControl.paths.specification = 'http://hl7.org/fhir/DSTU2';
    delete igControl.dependencyList;
    // igControl.dependencyList = [{
    //   name : 'argonaut',
    //   location : 'https://www.fhir.org/guides/argonaut/r2',
    //   version: '1.0.0'
    // }];
  }

  // Update igControl to use configuration specifications
  igControl.canonicalBase = config.fhirURL;

  // Update igControl to specify npm-name if applicable
  if (config.implementationGuide && config.implementationGuide.npmName) {
    igControl['npm-name'] = config.implementationGuide.npmName.trim();
  } else {
    delete(igControl['npm-name']);
  }

  // Update igControl to specify fixed-business-version if applicable
  if (config.implementationGuide && config.implementationGuide.version) {
    igControl['fixed-business-version'] = config.implementationGuide.version.trim();
  } else {
    delete(igControl['fixed-business-version']);
  }

  // Rewrite base files to use project names
  const igIndexHtmlPath = path.join(outDir, 'pages');
  const igIndexHtml = fs.readFileSync(path.join(igIndexHtmlPath, 'index.html'), 'utf8');
  let igIndexContentPath = path.join(specPath, config.implementationGuide.indexContent);

  if (fs.lstatSync(igIndexContentPath).isDirectory()) {
    const files = fs.readdirSync(igIndexContentPath, 'utf8');
    for (const file of files) {
      if (file.endsWith('.html')) {
        let fileContent = fs.readFileSync(path.join(igIndexContentPath, file), 'utf8');
        fs.writeFileSync(path.join(igIndexHtmlPath, file), igIndexHtml.replace('<igIndexContent-go-here>', fileContent), 'utf8');
      } else {
        let readStream = fs.createReadStream(path.join(igIndexContentPath, file));
        readStream.pipe(fs.createWriteStream(path.join(igIndexHtmlPath, file)));
      }
    }
  } else {
    let igIndexContent;
    try {
      igIndexContent = fs.readFileSync(igIndexContentPath, 'utf8');
    } catch (error) {
      igIndexContent =
  `<p> This is a ${config.projectName} FHIR implementation guide. </p>`;
      fs.writeFileSync(igIndexContentPath, igIndexContent, 'utf8');
    }
    fs.writeFileSync(path.join(igIndexHtmlPath, 'index.html'), igIndexHtml.replace('<igIndexContent-go-here>', igIndexContent), 'utf8');
  }

  // For each profile, extension, value set, and code system
  // 1. Copy it into the corresponding resources subfolder
  // 2. Add it to the IG JSON control file
  // 3. Add it to the IG XML file
  // 4. Add it to the corresponding HTML listing file
  // 5. Create the mapping xhtml file (profiles only)

  // The entry map is used to determine if a profile or model is an entry or not
  const idToElementMap = new Map();
  for (const element of specifications.dataElements.all) {
    idToElementMap.set(common.fhirID(element.identifier), element);
    idToElementMap.set(common.fhirID(element.identifier, 'model'), element);
  }

  let isPrimaryFn;
  // If strategy is "namespace", set every entry within selected namespaces as primary
  if (config.implementationGuide.primarySelectionStrategy && config.implementationGuide.primarySelectionStrategy.strategy === 'namespace') {
    const primary = config.implementationGuide.primarySelectionStrategy.primary;
    if (Array.isArray(primary)) {
      isPrimaryFn = (id) => {
        return (idToElementMap.get(id).isEntry) && (primary.indexOf(idToElementMap.get(id).identifier.namespace) != -1);
      };
    } else {
      // TODO: Get a logger!
      console.error('Namespace strategy requires config.implementationGuide.primarySelectionStrategy.primary to be an array');
    }
  // If strategy is "hybrid", set every entry within selected namespaces and every selected entry as primary
  } else if (config.implementationGuide.primarySelectionStrategy && config.implementationGuide.primarySelectionStrategy.strategy === 'hybrid') {
    const primary = config.implementationGuide.primarySelectionStrategy.primary;
    if (Array.isArray(primary)) {
      isPrimaryFn = (id) => {
        return (idToElementMap.get(id).isEntry) && ((primary.indexOf(idToElementMap.get(id).identifier.name) != -1) || (primary.indexOf(idToElementMap.get(id).identifier.namespace) != -1) || (primary.indexOf(idToElementMap.get(id).identifier.fqn) != -1));
      };
    } else {
      // TODO: Get a logger!
      console.error('Hybrid strategy requires config.implementationGuide.primarySelectionStrategy.primary to be an array');
    }
  }
  if (isPrimaryFn == null) {
    // If strategy is "entry" or default, set every entry as primary
    isPrimaryFn = (id) => {
      return idToElementMap.get(id).isEntry;
    };
  }

  for (const valueSet of fhirResults.valueSets) {
    localValueSetUrls.add(valueSet.url);
  }

  const pushXmlResource = (reference, display, purpose) => {
    if (target === 'FHIR_DSTU_2') {
      xmlResources.push(`<resource>
          <purpose value="${purpose}" />
          <sourceReference>
              <reference value="${reference}" />
              <display value="${display}" />
          </sourceReference>
      </resource>
      `);
    } else {
      xmlResources.push(`<resource>
          <example value="${purpose === 'example'}" />
          <sourceReference>
            <reference value="${reference}" />
            <display value="${display}" />
          </sourceReference>
      </resource>
      `);
    }
  };

  fhirResults.profiles.sort(byName);
  const sdPath = path.join(outDir, 'resources');
  fs.ensureDirSync(sdPath);
  for (const profile of fhirResults.profiles) {
    fs.writeFileSync(path.join(sdPath, `structuredefinition-${profile.id}.json`), JSON.stringify(profile, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${profile.id}`] = {
      'base': `StructureDefinition-${profile.id}.html`
    };
    pushXmlResource(`StructureDefinition/${profile.id}`, MVH.sdTitle(profile), 'profile');

    const name = MVH.sdTitle(profile).replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Profile$/, '');
    const sdType = MVH.sdType(profile);
    let fhirHREF;
    const fhirJSON = fhir.find(sdType);
    if (fhirJSON && fhirJSON.kind === 'resource') {
      fhirHREF = `http://hl7.org/fhir/STU3/${sdType.toLowerCase()}.html`;
    } else {
      fhirHREF = `http://hl7.org/fhir/STU3/datatypes.html#${sdType.toLowerCase()}`;
    }
    const htmlSnippet =
    `<tr>
      <td><a href="StructureDefinition-${profile.id}.html">${name}</a></td>
      <td><a href="${fhirHREF}">${sdType}</a></td>
      <td>${markdownifiedText(profile.description)}</td>
    </tr>
    `;
    if (isPrimaryFn(profile.id)) {
      htmlPrimaryProfiles.push(htmlSnippet);

      for (const element of profile.snapshot.element) {
        if (element.path === `${sdType}.extension`
        || element.path === `${sdType}.modifierExtension`) {
          for (const type of element.type) {
            if (MVH.typeProfile(type)) {
              primaryExtensionUrls.add(MVH.typeProfile(type));
            }
          }
        }

        if (element.binding
        && element.binding.valueSetReference
        && element.binding.valueSetReference.reference) {
          const url = element.binding.valueSetReference.reference;
          if (localValueSetUrls.has(url)) {
            primaryLocalValueSetUrls.add(url);
          } else {
            externalValueSetUrls.add(url);
            primaryExternalValueSetUrls.add(url);
          }
        }

        if (element.path.endsWith('.system')
        && element.fixedUri) {
          primaryCodeSystemUrls.add(element.fixedUri);
        }
      }
    } else {
      htmlSupportProfiles.push(htmlSnippet);

      for (const element of profile.snapshot.element) {
        if (element.binding
        && element.binding.valueSetReference
        && element.binding.valueSetReference.reference) {
          const url = element.binding.valueSetReference.reference;
          if (!localValueSetUrls.has(url)) {
            externalValueSetUrls.add(url);
          }
        }
      }
    }

    const mapRegExp = /^.*<pre>([^]*)<\/pre>.*$/mg;
    const match = mapRegExp.exec(profile.text.div);
    const mapPath = path.join(outDir, 'pages', '_includes', `${profile.id}-cameo-mapping.xhtml`);
    // The following makes an assumption that the spec is copied into the ig output at 'spec'
    if (match && match.length > 0) {
      fs.writeFileSync(mapPath,
`
<p> </p>
<p><b>${config.projectShorthand} Mapping Source</b></p>
<p>This structure represents the following ${config.projectShorthand} mapping definition:</p>
<pre>
${match[1]}
</pre>`
      , 'utf8');
    } else {
      fs.writeFileSync(mapPath, '', 'utf8');
    }
  }

  // Apply the patched files
  const patchPath = path.join(__dirname, 'patches');
  const filterFunc = (src) => {
    if (src == patchPath) return true;
    if (src.endsWith('.json')) {
      console.warn(`WARNING: Overwriting generated profile with patch: ${src}`);
      return true;
    }
    return false;
  };
  fs.copySync(patchPath, sdPath, { filter: filterFunc });

  const hideSupporting = config.implementationGuide
  && config.implementationGuide.primarySelectionStrategy
  && config.implementationGuide.primarySelectionStrategy.hideSupporting;

  const usingNamespaceStrategy = config.implementationGuide
  && config.implementationGuide.primarySelectionStrategy
  && (config.implementationGuide.primarySelectionStrategy.strategy === 'namespace');

  for (const extension of fhirResults.extensions.sort(byName)) {
    if (primaryExtensionUrls.has(extension.url)) {
      for (const element of extension.snapshot.element) {
        if (element.binding
        && element.binding.valueSetReference
        && element.binding.valueSetReference.reference) {
          const url = element.binding.valueSetReference.reference;
          if (localValueSetUrls.has(url)) {
            primaryLocalValueSetUrls.add(url);
          } else {
            externalValueSetUrls.add(url);
            primaryExternalValueSetUrls.add(url);
          }
        }
        if (element.path.endsWith('.system')
        && element.fixedUri) {
          primaryCodeSystemUrls.add(element.fixedUri);
        }
      }
    } else {
      for (const element of extension.snapshot.element) {
        if (element.binding
        && element.binding.valueSetReference
        && element.binding.valueSetReference.reference) {
          const url = element.binding.valueSetReference.reference;
          if (!localValueSetUrls.has(url)) {
            externalValueSetUrls.add(url);
          }
        }
      }
    }

    fs.writeFileSync(path.join(sdPath, `structuredefinition-${extension.id}.json`), JSON.stringify(extension, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${extension.id}`] = {
      'base': `StructureDefinition-${extension.id}.html`,
      'template-base': 'sd-extension.html',
    };
    pushXmlResource(`StructureDefinition/${extension.id}`, MVH.sdTitle(extension), 'extension');
    const name = MVH.sdTitle(extension).replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Extension$/, '');
    if (!hideSupporting || primaryExtensionUrls.has(extension.url)) {
      htmlExtensions.push(
        `<tr>
          <td><a href="StructureDefinition-${extension.id}.html">${name}</a></td>
          <td>${markdownifiedText(extension.description)}</td>
        </tr>
        `);
    }
  }

  fhirResults.valueSets.sort(byName);
  const vsPath = path.join(outDir, 'resources');
  fs.ensureDirSync(vsPath);
  for (const valueSet of fhirResults.valueSets) {
    if (usingNamespaceStrategy) {
      const inNamespace = config.implementationGuide.primarySelectionStrategy.primary.some((p) => {
        return MVH.vsIdentifier(valueSet).some((i) => {
          return i.value.startsWith(p);
        });
      });
      if (inNamespace) {
        primaryLocalValueSetUrls.add(valueSet.url);
      }
    }

    if (primaryLocalValueSetUrls.has(valueSet.url)) {
      if (valueSet.codeSystem && valueSet.codeSystem.system && valueSet.codeSystem.system.length > 0) {
        primaryCodeSystemUrls.add(valueSet.codeSystem.system);
      }
      if (valueSet.compose && valueSet.compose.include) {
        for (const include of valueSet.compose.include) {
          if (include.system) {
            primaryCodeSystemUrls.add(include.system);
          }
        }
      }
    }

    fs.writeFileSync(path.join(vsPath, `valueset-${valueSet.id}.json`), JSON.stringify(valueSet, null, 2), 'utf8');
    igControl.resources[`ValueSet/${valueSet.id}`] = {
      'base': `ValueSet-${valueSet.id}.html`
    };
    if (!valueSet.url.startsWith(config.fhirURL)) {
      igControl['special-urls'].push(valueSet.url);
    }
    pushXmlResource(`ValueSet/${valueSet.id}`, MVH.vsTitle(valueSet), 'terminology');

    const name = MVH.vsTitle(valueSet).replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ ValueSet$/, '');
    if (!hideSupporting || primaryLocalValueSetUrls.has(valueSet.url)) {
      htmlLocalValueSets.push(
        `<tr>
          <td><a href="ValueSet-${valueSet.id}.html">${name}</a></td>
          <td>${markdownifiedText(valueSet.description)}</td>
        </tr>
        `);
    }
  }

  let externalValueSetInfo;
  if (hideSupporting) {
    externalValueSetInfo = Array.from(primaryExternalValueSetUrls)
      .map(url => { return getValueSetInfo(url, fhir.valueSets); });
  } else {
    externalValueSetInfo = Array.from(externalValueSetUrls)
      .map(url => { return getValueSetInfo(url, fhir.valueSets); });
  }

  externalValueSetInfo.sort(byName);
  for (const vsInfo of externalValueSetInfo) {
    htmlExternalValueSets.push(
      `<tr>
        <td><a href="${vsInfo.url}">${vsInfo.name}</a></td>
        <td>${markdownifiedText(vsInfo.description)}</td>
      </tr>
      `);
  }

  if (target !== 'FHIR_DSTU_2') {
    fhirResults.codeSystems.sort(byName);
    const csPath = path.join(outDir, 'resources');
    fs.ensureDirSync(csPath);
    for (const codeSystem of fhirResults.codeSystems) {
      if (usingNamespaceStrategy) {
        const inNamespace = config.implementationGuide.primarySelectionStrategy.primary.some((p) => {
          return codeSystem.identifier.value.startsWith(p);
        });
        if (inNamespace) {
          primaryCodeSystemUrls.add(codeSystem.url);
        }
      }

      fs.writeFileSync(path.join(csPath, `codesystem-${codeSystem.id}.json`), JSON.stringify(codeSystem, null, 2), 'utf8');
      igControl.resources[`CodeSystem/${codeSystem.id}`] = {
        'base': `CodeSystem-${codeSystem.id}.html`
      };
      if (!codeSystem.url.startsWith(config.fhirURL)) {
        igControl['special-urls'].push(codeSystem.url);
      }
      pushXmlResource(`CodeSystem/${codeSystem.id}`, codeSystem.title, 'terminology');

      const name = codeSystem.title.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ CodeSystem$/, '');
      if (!hideSupporting || primaryCodeSystemUrls.has(codeSystem.url)) {
        htmlCodeSystems.push(
        `<tr>
          <td><a href="CodeSystem-${codeSystem.id}.html">${name}</a></td>
          <td>${markdownifiedText(codeSystem.description)}</td>
        </tr>
        `);
      }
    }
  }

  if (config.implementationGuide.includeLogicalModels) {
    fhirResults.models.sort(byName);
    for (const model of fhirResults.models) {
      const hasConstraints = model.snapshot.element.some(e => e.constraints != null);
      fs.writeFileSync(path.join(sdPath, `structuredefinition-${model.id}.json`), JSON.stringify(model, null, 2), 'utf8');
      igControl.resources[`StructureDefinition/${model.id}`] = {
        'base': `StructureDefinition-${model.id}.html`,
        'template-base': hasConstraints ? 'sd-logical-w-constraints.html' : 'sd-logical.html',
        'pseudo-json': false,
        'pseudo-xml': false,
        'pseudo-ttl': false
      };
      pushXmlResource(`StructureDefinition/${model.id}`, model.name, 'logical');

      const name = MVH.sdTitle(model).replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Logical Model$/, '');
      const htmlSnippet =
      `<tr>
        <td><a href="StructureDefinition-${model.id}.html">${name}</a></td>
        <td>${markdownifiedText(model.description)}</td>
      </tr>
      `;
      if (isPrimaryFn(model.id)) {
        htmlPrimaryModels.push(htmlSnippet);
      } else {
        htmlSupportModels.push(htmlSnippet);
      }
    }
  }

  // Add in examples (if they exist)
  const fhirExamplesPath = path.join(specPath, 'fhir_examples');
  if (fs.existsSync(fhirExamplesPath)) {
    igControl.paths.resources.push('examples');
    const outExamplesFolder = path.join(outDir, 'examples');
    fs.ensureDirSync(outExamplesFolder);
    for (const exFile of fs.readdirSync(fhirExamplesPath)) {
      const exFilePath = path.join(fhirExamplesPath, exFile);
      try {
        const example = JSON.parse(fs.readFileSync(exFilePath, 'utf8'));
        if (!example.resourceType || !example.id) {
          console.warn('Invalid example.  Example JSON must include id and resourceType properties:', exFilePath);
          continue;
        }
        fs.writeFileSync(path.join(outExamplesFolder, exFile), JSON.stringify(example, null, 2), 'utf8');
        if (!igControl.defaults[example.resourceType]) {
          igControl.defaults[example.resourceType] = {
            'template-base': 'ex.html',
            'template-format': 'ex.html'
          };
        }
        igControl.resources[`${example.resourceType}/${example.id}`] = {
          'base': `${example.resourceType}-${example.id}.html`,
          'source': exFile
        };
        // Add the resource to the XML
        pushXmlResource(`${example.resourceType}/${example.id}`, `Example: ${example.id}`, 'example');
      } catch (e) {
        console.warn('Invalid example.  Example must be valid JSON:', exFilePath, e);
      }
    }
  }

  /* IT APPEARS THAT THIS IS NOT NEEDED ANYMORE, BUT ONLY COMMENTING IT OUT BECAUSE I MIGHT BE WRONG.
     ONCE CONFIDENT, WE CAN ALSO DELETE THE validator.pack FILES.

  if (target === 'FHIR_DSTU_2') {
    // Copy over the Argonaut validator file.
    fs.copySync(path.join(__dirname, 'definitions', 'FHIR_DSTU_2', 'IGs', 'Argonaut', 'validator.pack'),
      path.join(outDir, 'argonaut', 'validator.pack'));
  } else {
    // Copy over the US Core validator file.  This is needed due to a bug in the published US-Core.
    // See: https://chat.fhir.org/#narrow/stream/implementers/topic/Publisher.20broken.20when.20using.20.20uscore.20dependency.3F
    // See: https://chat.fhir.org/#narrow/stream/committers/subject/IG.20Publisher.20Error/near/136497
    fs.copySync(path.join(__dirname, 'definitions', 'FHIR_STU_3', 'IGs', 'US_Core', 'validator.pack'),
      path.join(outDir, 'uscore', 'validator.pack'));
  }

  */

  // Rewrite the updated IG JSON control file
  fs.writeFileSync(igControlPath, JSON.stringify(igControl, null, 2), 'utf8');

  // Rewrite the updated IG XML file
  const igXmlPath = path.join(outDir, 'resources', 'ig.xml');
  let igXml = fs.readFileSync(igXmlPath, 'utf8')
    .replace('<resources-go-here/>', xmlResources.join(''))
    .replace(/<project-name-go-here>/g, config.projectName)
    .replace('<ig-url-go-here>', config.fhirURL);
  if (target === 'FHIR_DSTU_2') {
    igXml = igXml
      .replace('<fhirVersion value="3.0.1"/>', '<fhirVersion value="1.0.2"/>')
      .replace('<title ', '<name ');
  }
  fs.writeFileSync(igXmlPath, igXml, 'utf8');

  // Rewrite the updated Profiles HTML file
  const profilesHtmlPath = path.join(outDir, 'pages', 'profiles.html');
  const profilesHtml = fs.readFileSync(profilesHtmlPath, 'utf8');
  let updatedProfilesHtml = profilesHtml.replace('<primary-profiles-go-here/>', htmlPrimaryProfiles.join(''))
    .replace('<support-profiles-go-here/>', htmlSupportProfiles.join(''))
    .replace('<project-shorthand-go-here/>', config.projectShorthand);
  if (hideSupporting) {
    updatedProfilesHtml = updatedProfilesHtml
      .replace('<h2 id="supporting-profiles-header">', '<h2 id="supporting-profiles-header" style="display: none">')
      .replace('<table id="supporting-profiles-table" class="codes">', '<table id="supporting-profiles-table" class="codes" style="display: none">');
  }

  fs.writeFileSync(profilesHtmlPath, updatedProfilesHtml, 'utf8');

  // Rewrite the updated Extensions HTML file
  const extensionsHtmlPath = path.join(outDir, 'pages', 'extensions.html');
  const extensionsHtml = fs.readFileSync(extensionsHtmlPath, 'utf8');
  let updatedExtensionsHtml = extensionsHtml.replace('<extensions-go-here/>', htmlExtensions.join(''))
    .replace('<project-shorthand-go-here/>', config.projectShorthand);
  if (htmlExtensions.length === 0) {
    updatedExtensionsHtml = updatedExtensionsHtml
      .replace('<table class="codes">', 'None\n<table class="codes" style="display: none">');
  }
  if (hideSupporting) {
    updatedExtensionsHtml = updatedExtensionsHtml
      .replace('<extensions-header/>', '<h2>Primary extensions defined as part of this Implementation Guide</h2>');
  } else {
    updatedExtensionsHtml = updatedExtensionsHtml
      .replace('<extensions-header/>', '<h2>Extensions defined as part of this Implementation Guide</h2>');
  }

  fs.writeFileSync(extensionsHtmlPath, updatedExtensionsHtml, 'utf8');

  // Rewrite the updated ValueSets HTML file
  const valueSetsHtmlPath = path.join(outDir, 'pages', 'valuesets.html');
  const valueSetsHtml = fs.readFileSync(valueSetsHtmlPath, 'utf8');
  let updatedValueSetsHtml = valueSetsHtml.replace('<local-value-sets-go-here/>', htmlLocalValueSets.join(''))
    .replace('<external-value-sets-go-here/>', htmlExternalValueSets.join(''))
    .replace('<project-shorthand-go-here/>', config.projectShorthand);
  if (hideSupporting) {
    updatedValueSetsHtml = updatedValueSetsHtml
      .replace('<local-value-sets-header/>', '<h2>Primary local value sets used in this Implementation Guide</h2>')
      .replace('<external-value-sets-header/>', '<h2>Primary external value sets used in this Implementation Guide</h2>');
  } else {
    updatedValueSetsHtml = updatedValueSetsHtml
      .replace('<local-value-sets-header/>', '<h2>Local value sets used in this Implementation Guide</h2>')
      .replace('<external-value-sets-header/>', '<h2>External value sets used in this Implementation Guide</h2>');
  }
  if (htmlLocalValueSets.length === 0) {
    updatedValueSetsHtml = updatedValueSetsHtml
      .replace('<table class="codes local">', 'None\n<table class="codes local" style="display: none">');
  }
  if (htmlExternalValueSets.length === 0) {
    updatedValueSetsHtml = updatedValueSetsHtml
      .replace('<table class="codes external">', 'None\n<table class="codes external" style="display: none">');
  }

  fs.writeFileSync(valueSetsHtmlPath, updatedValueSetsHtml, 'utf8');

  // Rewrite the updated CodeSystems HTML file
  const codeSystemsHtmlPath = path.join(outDir, 'pages', 'codesystems.html');
  const codeSystemsHtml = fs.readFileSync(codeSystemsHtmlPath, 'utf8');
  const codeSystemsDisclaimer = `<p>The code systems listed below include:</p>
  <ol>
    <li>code systems used in the definition of value sets in this IG; and</li>
    <li>code systems for individual codes used directly in the logical models and profiles.</li>
  </ol>
  <p>This list is not inclusive of code systems associated with external value sets used in the IG.</p>`;
  let updatedCodeSystemsHtml = codeSystemsHtml.replace('<code-systems-go-here/>', htmlCodeSystems.join(''))
    .replace('<code-systems-disclaimer/>', codeSystemsDisclaimer)
    .replace('<project-shorthand-go-here/>', config.projectShorthand);
  if (hideSupporting) {
    updatedCodeSystemsHtml = updatedCodeSystemsHtml
      .replace('<code-systems-header/>', '<h2>Primary code systems used in this Implementation Guide</h2>');
  } else {
    updatedCodeSystemsHtml = updatedCodeSystemsHtml
      .replace('<code-systems-header/>', '<h2>Code systems used in this Implementation Guide</h2>');
  }
  if (htmlCodeSystems.length === 0) {
    updatedCodeSystemsHtml = updatedCodeSystemsHtml
      .replace('<table class="codes">', 'None\n<table class="codes" style="display: none">');
  }

  fs.writeFileSync(codeSystemsHtmlPath, updatedCodeSystemsHtml, 'utf8');

  // Rewrite the updated Models HTML file
  const modelsHtmlPath = path.join(outDir, 'pages', 'logical.html');
  const modelsHtml = fs.readFileSync(modelsHtmlPath, 'utf8');
  let updatedModelsHtml = modelsHtml.replace('<primary-models-go-here/>', htmlPrimaryModels.join(''))
    .replace('<support-models-go-here/>', htmlSupportModels.join(''))
    .replace('<project-shorthand-go-here/>', config.projectShorthand);
  if (hideSupporting) {
    updatedModelsHtml = updatedModelsHtml
      .replace('<h2 id="supporting-models-header">', '<h2 id="supporting-models-header" style="display: none">')
      .replace('<table id="supporting-models-table" class="codes">', '<table id="supporting-models-table" class="codes" style="display: none">');
  }

  fs.writeFileSync(modelsHtmlPath, updatedModelsHtml, 'utf8');
  const navbarPath = path.join(outDir, 'pages', '_includes', 'navbar.html');
  let navbarHtml = fs.readFileSync(navbarPath, 'utf8');
  if (!config.implementationGuide.includeLogicalModels) {
    const modelsItem = '<li><a href="logical.html">Logical Models</a></li>';
    navbarHtml = navbarHtml.replace(modelsItem, '<!-- no logical models -->');
  }
  if (!config.implementationGuide.includeModelDoc) {
    const browserItem = '<li><a href="modeldoc.html">Reference Model</a></li>';
    navbarHtml = navbarHtml.replace(browserItem, '<!-- no reference model -->');
  }
  if (target === 'FHIR_DSTU_2') {
    const modelsItem = '<li><a href="codesystems.html">Code Systems</a></li>';
    navbarHtml = navbarHtml.replace(modelsItem, '<!-- no code systems (DSTU2) -->');
  }
  const historyItem = '<history-link-goes-here/>';
  if (config.implementationGuide.historyLink && config.implementationGuide.historyLink.trim().length > 0) {
    navbarHtml = navbarHtml.replace(historyItem, `<li><a href="${config.implementationGuide.historyLink.trim()}">History</a></li>`);
  } else {
    navbarHtml = navbarHtml.replace(historyItem, '');
  }
  fs.writeFileSync(navbarPath, navbarHtml);

  // Rewrite the updated Downloads HTML file (DSTU2 only)
  if (target === 'FHIR_DSTU_2') {
    // The IG publisher doesn't create a TTL downloads file for DSTU2
    const downloadsHtmlPath = path.join(outDir, 'pages', 'downloads.html');
    const downloadsHtml = fs.readFileSync(downloadsHtmlPath, 'utf8');
    const updatedDownloadsHtml = downloadsHtml
      .replace('<li><a href="definitions.ttl.zip">Turtle Definitions [ZIP]</a></li>', '')
      .replace('<li><a href="examples.ttl.zip">Turtle Examples [ZIP]</a></li>', '');
    fs.writeFileSync(downloadsHtmlPath, updatedDownloadsHtml, 'utf8');
  }
}

function getValueSetInfo(url, definitionValueSets) {
  let valueSetUrl;
  let valueSetName;
  let valueSetDescription;

  if (url.includes('http://hl7.org/fhir/us/core/ValueSet/')) {
    valueSetUrl = url.replace('http://hl7.org/fhir/us/core/ValueSet/', 'http://www.hl7.org/fhir/us/core/ValueSet-');
    valueSetUrl = `${valueSetUrl}.html`;
  } else if (url.includes('http://fhir.org/guides/argonaut/ValueSet/')) {
    valueSetUrl = url.replace('http://fhir.org/guides/argonaut/ValueSet/', 'https://www.fhir.org/guides/argonaut/r2/ValueSet-');
    valueSetUrl = `${valueSetUrl}.html`;
  } else {
    valueSetUrl = url;
  }

  const valueSet = definitionValueSets.find(function(vs) {
    return vs.url === url;
  });

  if (valueSet) {
    valueSetName = valueSet.name;
    valueSetDescription = valueSet.description;
  } else {
    valueSetName = valueSetUrl;
  }

  return { url: valueSetUrl, name: valueSetName, description: valueSetDescription };
}

function markdownifiedText(text) {
  if (text != null) {
    return `{% capture md_text %}${text}{% endcapture %}{{ md_text | markdownify }}`;
  }
  return '';
}

function byName(a, b) {
  if (a.name < b.name) {
    return -1;
  } else if (a.name > b.name) {
    return 1;
  }
  return 0;
}

module.exports = {exportIG};
