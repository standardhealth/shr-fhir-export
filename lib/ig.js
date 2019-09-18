const path = require('path');
const fs = require('fs-extra');
const bunyan = require('bunyan');
const common = require('./common');
const load = require('./load');
const MVH = require('./multiVersionHelper');

let logger = bunyan.createLogger({name: 'shr-fhir-export'});
function setLogger(bunyanLogger) {
  logger = bunyanLogger;
}

function exportIG(specifications, fhirResults, outDir, configuration = {}, specPath) {

  const config = configuration;
  // Avoid lots of null checks by initializing a config.implementationGuide if necessary
  if (!config.implementationGuide) {
    config.implementationGuide = {};
  }

  const target = common.getTarget(configuration, specifications);

  // Override includeLogicalModels if DSTU2 (not yet supported)
  if (target === 'FHIR_DSTU_2') {
    config.implementationGuide.includeLogicalModels = false;
  }

  // Load the FHIR definitions
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
  const htmlSearchParameters = [];
  const htmlOperationDefinitions = [];
  const htmlCapabilityStatements = [];
  const htmlConformances = [];
  const htmlExamples = [];

  const isHL7IG = config.fhirURL && /^https?:\/\/([^/]+\.)?(hl7|fhir)\.org\//.test(config.fhirURL);

  // Update igControl version and dependency list if applicable
  if (target === 'FHIR_DSTU_2') {
    igControl.version = '1.0.2';
    igControl.paths.specification = 'http://hl7.org/fhir/DSTU2';
    delete igControl.dependencyList;
    // CURRENTLY BROKEN.
    // See: https://chat.fhir.org/#narrow/stream/179252-IG-creation/topic/IG.20Dependency.20on.20Argonaut
    // See: https://chat.fhir.org/#narrow/stream/179252-IG-creation/topic/Rendering.20Argo.20extensions.20in.20custom.20IG
    // igControl.dependencyList = [{
    //   name : 'argonaut',
    //   location : 'http://fhir.org/guides/argonaut/r2',
    //   version: '1.0.0'
    // }];
  } else if (target === 'FHIR_STU_3') {
    igControl.version = '3.0.1';
    igControl.paths.specification = 'http://hl7.org/fhir/STU3';
    igControl.dependencyList = [{
      name: 'uscore',
      location: 'http://hl7.org/fhir/us/core',
      version: '1.0.1'
    }];
  } else if (target === 'FHIR_R4') {
    // Use the US Core 4.0.0 "current" version already specified in ig.json
  }

  // Update igControl to use configuration specifications
  igControl.canonicalBase = config.fhirURL;

  // Update igControl to specify npm-name if applicable
  if (config.implementationGuide.npmName) {
    igControl['npm-name'] = config.implementationGuide.npmName.trim();
  } else {
    delete(igControl['npm-name']);
  }

  // Update igControl to specify fixed-business-version if applicable
  if (config.implementationGuide.version) {
    igControl['fixed-business-version'] = config.implementationGuide.version.trim();
  } else {
    delete(igControl['fixed-business-version']);
  }

  // Update igControl history link
  if (isHL7IG && !config.implementationGuide.historyLink) {
    config.implementationGuide.historyLink = `${config.fhirURL}/history.html`;
  }
  if (config.implementationGuide.historyLink) {
    igControl.paths.history = config.implementationGuide.historyLink;
  }

  // Write out the _data.info.json file needed by Jekyll for data not available by default.
  // Items in infoJSON will be available in Jekyll templates via {{site.data.info.*}}
  const infoJSON = {};
  if (config.implementationGuide.ballotStatus) {
    infoJSON.title = `${config.projectName} ${config.implementationGuide.ballotStatus}`;
  } else {
    infoJSON.title = config.projectName;
  }
  if (config.copyrightYear) {
    infoJSON.copyrightYear = `${config.copyrightYear}`; // force string in case it is a number
  } else {
    infoJSON.copyrightYear = `${(new Date()).getFullYear()}+`;
  }
  if (config.implementationGuide.historyLink) {
    infoJSON.historyLink = config.implementationGuide.historyLink;
  }
  if (config.implementationGuide.changesLink) {
    infoJSON.changesLink = config.implementationGuide.changesLink;
  } else if (isHL7IG) {
    // Just use the FHIR changes link
    infoJSON.changesLink = 'http://gforge.hl7.org/gf/project/fhir/tracker/?action=TrackerItemAdd&amp;tracker_id=677';
  }
  const dataPath = path.join(outDir, 'pages', '_data');
  const infoPath = path.join(dataPath, 'info.json');
  fs.mkdirpSync(dataPath);
  fs.writeJSONSync(infoPath, infoJSON);

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

  // Handle the package-list.json (see: http://wiki.hl7.org/index.php?title=FHIR_IG_PackageList_doco)
  let packageListFile;
  if (config.implementationGuide.packageList) {
    packageListFile = path.join(specPath, config.implementationGuide.packageList.trim());
  } else if (isHL7IG) {
    // if it's an IG, we must have one, so default to package-list.json
    packageListFile = path.join(specPath, 'package-list.json');
  }

  if (packageListFile) {
    // Now get or create the package list file
    let packageList;
    if (fs.existsSync(packageListFile)) {
      // Get the existing one
      packageList = JSON.parse(fs.readFileSync(packageListFile, 'utf8'));
    } else {
      // Create a new one using data in the config
      packageList = {
        'package-id': igControl['npm-name'] || 'npm-name-goes-here',
        title: config.projectName || 'title goes here',
        canonical: igControl.canonicalBase,
        list: [{
          version: 'current',
          desc: 'Continuous Integration Build (latest in version control)',
          path: 'http://build.fhir.org/ig/HL7/xxx',
          status: 'ci-build',
          current: true
        }]
      };
      if (igControl['fixed-business-version'] != null) {
        // @ts-ignore
        packageList.list.push({
          version: igControl['fixed-business-version'],
          date: config.publishDate || common.todayString(),
          desc: config.implementationGuide.ballotStatus ? infoJSON.title: 'Initial Version',
          path: igControl.canonicalBase,
          status: 'draft',
          sequence: 'STU 1',
          'fhir-version': igControl.version
        });
      }
      fs.writeFileSync(packageListFile, JSON.stringify(packageList, null, 2), 'utf8');
      // 03021, 'HL7 IGs require a package-list.json file.  A starter version has been written to ${packageListFile}. For more information on package files, see: http://wiki.hl7.org/index.php?title=FHIR_IG_PackageList_doco', 'Edit the packageListFile', 'errorNumber'
      logger.warn( { packageListFile }, '03021');
    }

    // Check the package list for obvious issues
    if (packageList['package-id'] !== igControl['npm-name']) {
      // 13116, 'Package-id '${packageId}' (found in package-list.json) does not match npm-name '${npmName}' from config file', 'Fix packageId in package-list.json file', 'errorNumber'
      logger.error({ packageId: packageList['package-id'], npmName: igControl['npm-name'] }, '13116');
    }
    if (packageList['package-id'] !== igControl['npm-name']) {
      // 13117, 'Canonical URL '${packageUrl}' (found in package-list.json) does not match canonical URL '${canonicalUrl}' from config file', 'Fix canonical URL in package-list.json file', 'errorNumber'
      logger.error({ packageUrl: packageList['canonical'], canonicalUrl: igControl['canonicalBase'] }, '13117');
    }
    if (!packageList.list || packageList.list.length === 0) {
      // 13118, 'The package-list.json file must have at least one listed publication object', 'Add at least one publication object.', 'errorNumber'
      logger.error('13118');
    } else {
      const ci = packageList.list[0];
      if (ci.version !== 'current' || ci.status !== 'ci-build' || ci.current !== true) {
        // 13119, 'The first publication object in the package-list.json list must be the CI build (with "version":"curent", "status":"ci-build", and "current":true)', 'Add the CI Build entry to the publication objects in package-list.json', 'errorNumber'
        logger.error('13119');
      }
      if (!ci.path || ci.path.endsWith('xxx')) {
        // 13120, 'The package-list.json contains the invalid (placeholder) path for the CI build: ${ciPath}', 'Update the path to the CI build with the real CI build URL', 'errorNumber'
        logger.warn({ ciPath: ci.path }, '13120');
      }
    }

    // Now copy the package-list.json to the outdir
    fs.copySync(packageListFile, path.join(outDir, 'package-list.json'));
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
    idToElementMap.set(common.fhirID(element.identifier, 'extension'), element);
    idToElementMap.set(common.fhirID(element.identifier, 'model'), element);
  }

  let isPrimaryFn;
  // If strategy is "namespace", set every entry within selected namespaces as primary
  if (config.implementationGuide.primarySelectionStrategy && config.implementationGuide.primarySelectionStrategy.strategy === 'namespace') {
    const primary = config.implementationGuide.primarySelectionStrategy.primary;
    if (Array.isArray(primary)) {
      isPrimaryFn = (id) => {
        const element = idToElementMap.get(id);
        return element && (/-extension$/.test(id) || element.isEntry) && (primary.indexOf(element.identifier.namespace) != -1);
      };
    } else {
      // 13121, 'Namespace strategy requires config.implementationGuide.primarySelectionStrategy.primary to be an array', 'Update the config file so that config.implementationGuide.primarySelectionStrategy.primary is an array', 'errorNumber'
      logger.error('13121');
    }
  // If strategy is "hybrid", set every entry within selected namespaces and every selected entry as primary
  } else if (config.implementationGuide.primarySelectionStrategy && config.implementationGuide.primarySelectionStrategy.strategy === 'hybrid') {
    const primary = config.implementationGuide.primarySelectionStrategy.primary;
    if (Array.isArray(primary)) {
      isPrimaryFn = (id) => {
        const element = idToElementMap.get(id);
        return element && (/-extension$/.test(id) || element.isEntry) && ((primary.indexOf(element.identifier.name) != -1) || (primary.indexOf(element.identifier.namespace) != -1) || (primary.indexOf(element.identifier.fqn) != -1));
      };
    } else {
      // 13122, 'Hybrid strategy requires config.implementationGuide.primarySelectionStrategy.primary to be an array', 'Update the config file so that config.implementationGuide.primarySelectionStrategy.primary is an array', 'errorNumber'
      logger.error('13122');
    }
  }
  else if (specifications.contentProfiles.all.length > 0) {
    const primary = [];
    for (const cp of specifications.contentProfiles.all) {
      for (const cpr of cp.rules) {
        // Process element as primaryProfile if it is in ContentProfile
        if (cpr.primaryProfile) {
          primary.push(cp.identifier.fqn);
        }
      }
    }
    if (primary.length > 0) {
      isPrimaryFn = (id) => {
        const element = idToElementMap.get(id);
        return element && (/-extension$/.test(id) || element.isEntry) && ((primary.indexOf(element.identifier.name) != -1) || (primary.indexOf(element.identifier.namespace) != -1) || (primary.indexOf(element.identifier.fqn) != -1));
      };
    }
  }
  if (isPrimaryFn == null) {
    // If strategy is "entry" or default, set every entry as primary
    // But... don't ever return true for extensions when this strategy is used;
    // We only want the extensions *used* by primary profiles in that case!
    isPrimaryFn = (id) => {
      return !/-extension$/.test(id) && idToElementMap.get(id).isEntry;
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
    } else if (target === 'FHIR_STU_3') {
      xmlResources.push(`<resource>
          <example value="${purpose === 'example'}" />
          <sourceReference>
            <reference value="${reference}" />
            <display value="${display}" />
          </sourceReference>
      </resource>
      `);
    } else {
      // TODO: Include reference to profile example is for (if applicable)?
      xmlResources.push(`<resource>
          <exampleBoolean value="${purpose === 'example'}" />
          <reference>
            <reference value="${reference}" />
          </reference>
          <name value="${display}" />
      </resource>
      `);
    }
  };

  fhirResults.profiles.sort(byName);
  const sdPath = path.join(outDir, 'resources');
  fs.ensureDirSync(sdPath);
  let fhirSpecURLBase;
  switch (target) {
  case 'FHIR_DSTU_2': fhirSpecURLBase = 'http://hl7.org/fhir/DSTU2/'; break;
  case 'FHIR_STU_3':  fhirSpecURLBase = 'http://hl7.org/fhir/STU3/'; break;
  case 'FHIR_R4':     fhirSpecURLBase = 'http://hl7.org/fhir/R4/'; break;
  default:            fhirSpecURLBase = 'http://hl7.org/fhir/R4/'; break;
  }
  for (let profile of fhirResults.profiles) {
    // Identifiers and mappings are needed for ES6 class generation, but we don't want them in the
    // IG profiles because:
    // (a) the IG publisher reports errors when we use the canonical URL as the identifier system
    // (b) the mappings create tons of diffs where nothing meaningful has actually changed
    const baseSD = fhir.find(MVH.sdBaseDefinition(profile));
    profile = removeSHRMappings(profile, baseSD);
    delete profile.identifier;

    fs.writeFileSync(path.join(sdPath, `structuredefinition-${profile.id}.json`), JSON.stringify(profile, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${profile.id}`] = {
      'base': `StructureDefinition-${profile.id}.html`
    };
    pushXmlResource(`StructureDefinition/${profile.id}`, MVH.sdTitle(profile), 'profile');

    const name = profile.name;
    const sdType = MVH.sdType(profile);
    let fhirHREF;
    const fhirJSON = fhir.find(sdType);
    if (fhirJSON && fhirJSON.kind === 'resource') {
      fhirHREF = `${fhirSpecURLBase}${sdType.toLowerCase()}.html`;
    } else {
      fhirHREF = `${fhirSpecURLBase}datatypes.html#${sdType.toLowerCase()}`;
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
        if (element.path.endsWith('.extension')
        || element.path.endsWith('.modifierExtension')) {
          for (const type of element.type) {
            if (MVH.typeProfile(type)) {
              MVH.typeProfile(type).forEach(tp => primaryExtensionUrls.add(tp));
            }
          }
        }

        const bindVSURI = MVH.edBindingValueSet(profile, element);
        if (bindVSURI) {
          if (localValueSetUrls.has(bindVSURI)) {
            primaryLocalValueSetUrls.add(bindVSURI);
          } else {
            externalValueSetUrls.add(bindVSURI);
            primaryExternalValueSetUrls.add(bindVSURI);
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
        const bindVSURI = MVH.edBindingValueSet(profile, element);
        if (bindVSURI) {
          if (!localValueSetUrls.has(bindVSURI)) {
            externalValueSetUrls.add(bindVSURI);
          }
        }
      }
    }

    // Create the CIMPL to FHIR Mapping Includes File
    const mapRegExp = /^.*<pre>([^]*)<\/pre>.*$/mg;
    const match = mapRegExp.exec(profile.text.div);
    const mapPath = path.join(outDir, 'pages', '_includes', `${profile.id}-cameo-mapping.xhtml`);
    // The following makes an assumption that the spec is copied into the ig output at 'spec'
    if (match && match.length > 0) {
      fs.writeFileSync(mapPath,
        `
<p> </p>
<p><b>Mapping Source</b></p>
<p>This structure represents the following mapping definition:</p>
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
      // 03022, 'WARNING: Overwriting generated profile with patch: ${patchFile}',,
      logger.warn({ patchFile: src }, '03022');
      return true;
    }
    return false;
  };
  fs.copySync(patchPath, sdPath, { filter: filterFunc });

  const hideSupporting = (config.implementationGuide.primarySelectionStrategy
  && config.implementationGuide.primarySelectionStrategy.hideSupporting)
  || config.implementationGuide.showPrimaryOnly;

  const usingNamespaceStrategy = config.implementationGuide.primarySelectionStrategy
  && (config.implementationGuide.primarySelectionStrategy.strategy === 'namespace');

  for (let extension of fhirResults.extensions.sort(byName)) {
    // Identifiers and mappings are needed for ES6 class generation, but we don't want them in the
    // IG profiles because:
    // (a) the IG publisher reports errors when we use the canonical URL as the identifier system
    // (b) the mappings create tons of diffs where nothing meaningful has actually changed
    const baseSD = fhir.find(MVH.sdBaseDefinition(extension));
    extension = removeSHRMappings(extension, baseSD);
    delete extension.identifier;

    // We added extensions by their use in primary profiles, but now check if
    // it is eligible due to its namespace or fully qualifier name (based on strategy)
    if (isPrimaryFn(extension.id)) {
      primaryExtensionUrls.add(extension.url);
    }

    if (primaryExtensionUrls.has(extension.url)) {
      for (const element of extension.snapshot.element) {
        const bindVSURI = MVH.edBindingValueSet(extension, element);
        if (bindVSURI) {
          if (localValueSetUrls.has(bindVSURI)) {
            primaryLocalValueSetUrls.add(bindVSURI);
          } else {
            externalValueSetUrls.add(bindVSURI);
            primaryExternalValueSetUrls.add(bindVSURI);
          }
        }
        if (element.path.endsWith('.system')
        && element.fixedUri) {
          primaryCodeSystemUrls.add(element.fixedUri);
        }
      }
    } else {
      for (const element of extension.snapshot.element) {
        const bindVSURI = MVH.edBindingValueSet(extension, element);
        if (bindVSURI) {
          if (!localValueSetUrls.has(bindVSURI)) {
            externalValueSetUrls.add(bindVSURI);
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
    const name = extension.name;
    if (!hideSupporting || primaryExtensionUrls.has(extension.url)) {
      htmlExtensions.push(
        `<tr>
          <td><a href="StructureDefinition-${extension.id}.html">${name}</a></td>
          <td>${markdownifiedText(extension.description)}</td>
        </tr>
        `);
    }

    // Create the Extension Usage Includes File
    const usagePath = path.join(outDir, 'pages', '_includes', `${extension.id}-usage.xhtml`);
    const getUsesInStructDefs = (structDefs) => {
      const usages = [];
      structDefs.forEach(profile => {
        // Look through each of the snapshot elements for elements whose path ends with extension or modifierExtension
        // and who list this extension as the extension type.
        const usagePaths = new Set();
        profile.snapshot.element.forEach(ssEl => {
          // If it's an extension path and we haven't already recorded it (i.e., we don't want duplicates)...
          if (/\.(modifierE|e)xtension$/.test(ssEl.path) && !usagePaths.has(ssEl.path)) {
            if (ssEl.type && ssEl.type.some(t => t.code === 'Extension' && MVH.typeHasProfile(t, extension.url))) {
              usagePaths.add(ssEl.path);
              usages.push({
                name: profile.name,
                id: profile.id,
                path: ssEl.path
              });
            }
          }
        });
      });
      return usages;
    };
    const profileUses = getUsesInStructDefs(fhirResults.profiles);
    const extensionUses = getUsesInStructDefs(fhirResults.extensions);
    let usageSnippet = '';
    if (profileUses.length > 0) {
      usageSnippet = '<h4>Usage</h4>\n\n' +
      '<p>This extension is used in the following profiles:</p>' +
      '<ul>\n' +
      profileUses.map(u => {
        const on = u.path.slice(u.path.indexOf('.')+1, u.path.lastIndexOf('.'));
        return `  <li><a href="StructureDefinition-${u.id}.html">${u.name}</a>${on.length > 0 ? ` (on <tt>${on}</tt>)` : ''}</li>\n`;
      }).join('') +
      '</ul>\n';
    }
    if (extensionUses.length > 0) {
      if (usageSnippet.length === 0) {
        usageSnippet = '<h4>Usage</h4>\n\n';
      } else {
        usageSnippet += '\n';
      }
      usageSnippet += '<p>This extension is used in the following complex extensions:</p>' +
      '<ul>\n' +
      extensionUses.map(u => `  <li><a href="StructureDefinition-${u.id}.html">${u.name}</a></li>\n`).join('') +
      '</ul>\n\n';
    }
    fs.writeFileSync(usagePath, usageSnippet, 'utf8');
  }

  fhirResults.valueSets.sort(byName);
  const vsPath = path.join(outDir, 'resources');
  fs.ensureDirSync(vsPath);
  for (let valueSet of fhirResults.valueSets) {
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

    // Identifiers are needed for filtering (above) and ES6 class generation, but we don't want
    // them in the IG profiles because the IG publisher reports errors when we use the canonical
    // URL as the identifier system
    valueSet = common.cloneJSON(valueSet);
    delete valueSet.identifier;

    fs.writeFileSync(path.join(vsPath, `valueset-${valueSet.id}.json`), JSON.stringify(valueSet, null, 2), 'utf8');
    igControl.resources[`ValueSet/${valueSet.id}`] = {
      'base': `ValueSet-${valueSet.id}.html`
    };
    if (!valueSet.url.startsWith(config.fhirURL)) {
      igControl['special-urls'].push(valueSet.url);
    }
    pushXmlResource(`ValueSet/${valueSet.id}`, MVH.vsTitle(valueSet, target), 'terminology');

    const name = MVH.vsTitle(valueSet, target);
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
    for (let codeSystem of fhirResults.codeSystems) {
      if (usingNamespaceStrategy) {
        const inNamespace = config.implementationGuide.primarySelectionStrategy.primary.some((p) => {
          return MVH.csIdentifier(codeSystem).some((i) => {
            return i.value.startsWith(p);
          });
        });
        if (inNamespace) {
          primaryCodeSystemUrls.add(codeSystem.url);
        }
      }

      // Identifiers are needed for filtering (above) and ES6 class generation, but we don't want
      // them in the IG profiles because the IG publisher reports errors when we use the canonical
      // URL as the identifier system
      codeSystem = common.cloneJSON(codeSystem);
      delete codeSystem.identifier;

      fs.writeFileSync(path.join(csPath, `codesystem-${codeSystem.id}.json`), JSON.stringify(codeSystem, null, 2), 'utf8');
      igControl.resources[`CodeSystem/${codeSystem.id}`] = {
        'base': `CodeSystem-${codeSystem.id}.html`
      };
      if (!codeSystem.url.startsWith(config.fhirURL)) {
        igControl['special-urls'].push(codeSystem.url);
      }
      pushXmlResource(`CodeSystem/${codeSystem.id}`, codeSystem.title, 'terminology');

      const name = codeSystem.title;
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

      const name = model.name;
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

  // For each extra SearchParameter, OperationDefinition, Conformance, and CapabilityStatement:
  // 1. Copy it into the corresponding resources subfolder
  // 2. Add it to the IG JSON control file
  // 3. Add it to the IG XML file
  // 4. Add it to the corresponding HTML listing file
  let igExtraResourcesPath;
  if (config.implementationGuide.extraResources) {
    igExtraResourcesPath = path.join(specPath, config.implementationGuide.extraResources);
    if (!fs.existsSync(igExtraResourcesPath)) {
      // 13123, 'Specified extraResources path is not valid: ${path}', 'Fix or remove the implementationGuide.extraResources value in the config to be a valid path', 'errorNumber'
      logger.error({ path: igExtraResourcesPath }, '13123');
      igExtraResourcesPath = null;
    }
  }
  if (igExtraResourcesPath) {
    const outResourcesPath = path.join(outDir, 'resources');
    fs.ensureDirSync(outResourcesPath);
    for (const rscFile of fs.readdirSync(igExtraResourcesPath)) {
      const rscFilePath = path.join(igExtraResourcesPath, rscFile);
      try {
        const exResource = JSON.parse(fs.readFileSync(rscFilePath, 'utf8'));
        if (!exResource.resourceType || !exResource.id) {
          // 13124, 'Invalid extra resource. Extra resource JSON must include id and resourceType properties: ${resourcePath}.', 'Add id and/or resourceType to the resource', 'errorNumber'
          logger.error({ resourcePath: rscFilePath }, '13124');
          continue;
        } else if (exResource.fhirVersion && exResource.fhirVersion !== igControl.version) {
          // 13125, 'Invalid extra resource. IG is for FHIR ${igVersion}, but resource is for FHIR ${resourceVersion}: ${resourcePath}', 'Replace resource with resource using same FHIR version as the IG', 'errorNumber'
          logger.error({ igVersion: igControl.version, resourceVersion: exResource.fhirVersion, resourcePath: rscFilePath }, '13125');
          continue;
        }
        // For now, only support a subset of types
        let htmlRows;
        switch (exResource.resourceType) {
        case 'SearchParameter':
          htmlRows = htmlSearchParameters;
          break;
        case 'OperationDefinition':
          htmlRows = htmlOperationDefinitions;
          break;
        case 'CapabilityStatement':
          htmlRows = htmlCapabilityStatements;
          break;
        case 'Conformance':
          htmlRows = htmlConformances;
          break;
        default:
          // 13126, 'Invalid extra resource. Only the following resource types are currently supported: StructureDefinition, ValueSet, CodeSystem, SearchParameter, OperationDefinition, CapabilityStatement, Conformance.  Found: ${resourceType}.', 'Remove unsupported resource.', 'errorNumber'
          logger.error({ resourceType: exResource.resourceType }, '13126');
          continue;
        }

        fs.writeJSONSync(path.join(outResourcesPath, `${exResource.resourceType.toLowerCase()}-${exResource.id}.json`), exResource);
        igControl.resources[`${exResource.resourceType}/${exResource.id}`] = {
          'base': `${exResource.resourceType}-${exResource.id}.html`
        };
        const name = exResource.title || exResource.name;
        // None of the purpose codes are a clear fit for any of these, so use example.
        // See: https://chat.fhir.org/#narrow/stream/179252-IG-creation/topic/DSTU.20ig.2Exml.20package.2Eresource.2Epurpose.20for.20SearchParameters/near/168272354
        pushXmlResource(`${exResource.resourceType}/${exResource.id}`, name, 'example');

        if (exResource.resourceType === 'SearchParameter') {
          const baseTypes = Array.isArray(exResource.base) ? exResource.base.join(', ') : exResource.base;
          htmlRows.push(
            `<tr>
              <td><a href="${exResource.resourceType}-${exResource.id}.html">${exResource.code}</a></td>
              <td>${baseTypes}</td>
              <td>${exResource.type}</td>
              <td>${markdownifiedText(exResource.description)}</td>
            </tr>`
          );
        } else {
          htmlRows.push(
            `<tr>
              <td><a href="${exResource.resourceType}-${exResource.id}.html">${name}</a></td>
              <td>${markdownifiedText(exResource.description)}</td>
            </tr>
          `);
        }
      } catch (e) {
        // 13127, 'Invalid extra resource.  Resource must be valid JSON: ${resourcePath}.', 'Remove invalid JSON resource.', 'errorNumber'
        logger.error({ resourcePath: rscFilePath }, '13127');
      }
    }
  }

  // Add in examples (if they exist)
  let igExamplesPath;
  if (config.implementationGuide.examples) {
    igExamplesPath = path.join(specPath, config.implementationGuide.examples);
    if (!fs.existsSync(igExamplesPath)) {
      // 13128, 'Specified examples path is not valid: ${path}', 'Fix implementationGuide.examples config value to point to valid path', 'errorNumber'
      logger.error({ path: igExamplesPath }, '13128');
      igExamplesPath = null;
    }
  } else if (fs.existsSync(path.join(specPath, 'fhir_examples'))) {
    // For backwards compatibility, still use the fhir_examples folder if it exists
    igExamplesPath = path.join(specPath, 'fhir_examples');
  }
  if (igExamplesPath) {
    const examplesList = [];
    igControl.paths.resources.push('examples');
    const outExamplesFolder = path.join(outDir, 'examples');
    fs.ensureDirSync(outExamplesFolder);
    for (const exFile of fs.readdirSync(igExamplesPath)) {
      const exFilePath = path.join(igExamplesPath, exFile);
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
        examplesList.push(example);
      } catch (e) {
        console.warn('Invalid example.  Example must be valid JSON:', exFilePath, e);
      }
    }
    if (examplesList.length > 0) {
      // Add the example to the HTML
      examplesList.sort((a, b) => a.resourceType.localeCompare(b.resourceType));
      // Get a list of profiles for testing links
      const linkableProfiles = fhirResults.profiles.map(p => p.url);
      for (const example of examplesList) {
        let profileStrings = [];
        if (example.meta != null) {
          profileStrings = example.meta.profile.map(profile => {
            // Get a human readable version of the profile
            const trimmedProfile = profile.slice(profile.lastIndexOf('/') + 1);
            if (linkableProfiles.indexOf(profile) > -1) {
              return `<a href="StructureDefinition-${trimmedProfile}.html">${trimmedProfile}</a>`;
            } else {
              return `${trimmedProfile}`;
            }
          });
        }
        const profileString = profileStrings.join(', ');
        htmlExamples.push(
          `
          <tr>
            <td><a href="${example.resourceType}-${example.id}.html">${example.resourceType}-${example.id}</a></td>
            <td><a href="${fhirSpecURLBase}${example.resourceType.toLowerCase()}.html">${example.resourceType}</a></td>
            <td>${profileString}</td>
          </tr>
          `
        );
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
  // TODO: Use a real XML library.  The XML manipulation is getting out of control.
  let igId = config.implementationGuide.npmName;
  if (config.implementationGuide.version != null) {
    igId += `-${config.implementationGuide.version}`;
  }
  let publisherXML = '';
  if (config.publisher && config.publisher.length > 0) {
    publisherXML = `<publisher value="${config.publisher}"/>`;
  }
  let contactXML = '';
  if (config.contact && config.contact.length > 0 && config.contact[0].telecom && config.contact[0].telecom.length > 0) {
    for (const contact of config.contact) {
      contactXML += '<contact>\n';
      if (contact.name) {
        contactXML += `      <name value="${contact.name}"/>\n`;
      }
      if (contact.telecom) {
        for (const telecom of contact.telecom) {
          let system = telecom.system;
          // Oddly, DSTU2 doesn't support url or sms
          if (target === 'FHIR_DSTU_2' && ['phone', 'fax', 'email', 'pager'].indexOf(system) === -1) {
            system = 'other';
          }
          contactXML += '      <telecom>\n';
          contactXML += `        <system value="${system}"/>\n`;
          contactXML += `        <value value="${telecom.value}"/>\n`;
          contactXML += '      </telecom>\n';
        }
      }
      contactXML += '    </contact>\n';
    }
  }
  let igXml = fhir.implementationGuideTemplate
    .replace(/<ig-id-go-here>/g, igId)
    .replace('<resources-go-here/>', xmlResources.join(''))
    .replace('<tokenized-project-name-go-here>', common.tokenize(config.projectName))
    .replace(/<project-name-go-here>/g, config.projectName)
    .replace('<ig-url-go-here>', config.fhirURL)
    .replace('<publisher-go-here/>', publisherXML)
    .replace('<contact-go-here/>', contactXML)
    .replace('<npm-name-go-here>', config.implementationGuide.npmName);
  fs.mkdirpSync(path.join(outDir, 'resources'));
  const igXmlPath = path.join(outDir, 'resources', 'ig.xml');
  fs.writeFileSync(igXmlPath, igXml, 'utf8');

  // Rewrite the updated Profiles HTML file
  const profilesHtmlPath = path.join(outDir, 'pages', 'profiles.html');
  const profilesHtml = fs.readFileSync(profilesHtmlPath, 'utf8');
  let updatedProfilesHtml = profilesHtml.replace('<primary-profiles-go-here/>', htmlPrimaryProfiles.join(''))
    .replace('<support-profiles-go-here/>', htmlSupportProfiles.join(''));
  if (hideSupporting) {
    updatedProfilesHtml = updatedProfilesHtml
      .replace('<h2 id="supporting-profiles-header">', '<h2 id="supporting-profiles-header" style="display: none">')
      .replace('<table id="supporting-profiles-table" class="codes">', '<table id="supporting-profiles-table" class="codes" style="display: none">');
  }

  fs.writeFileSync(profilesHtmlPath, updatedProfilesHtml, 'utf8');

  // Rewrite the updated Extensions HTML file
  const extensionsHtmlPath = path.join(outDir, 'pages', 'extensions.html');
  const extensionsHtml = fs.readFileSync(extensionsHtmlPath, 'utf8');
  let updatedExtensionsHtml = extensionsHtml.replace('<extensions-go-here/>', htmlExtensions.join(''));
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
    .replace('<external-value-sets-go-here/>', htmlExternalValueSets.join(''));
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
    .replace('<code-systems-disclaimer/>', codeSystemsDisclaimer);
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
    .replace('<support-models-go-here/>', htmlSupportModels.join(''));
  if (hideSupporting) {
    updatedModelsHtml = updatedModelsHtml
      .replace('<h2 id="supporting-models-header">', '<h2 id="supporting-models-header" style="display: none">')
      .replace('<table id="supporting-models-table" class="codes">', '<table id="supporting-models-table" class="codes" style="display: none">');
  }
  fs.writeFileSync(modelsHtmlPath, updatedModelsHtml, 'utf8');

  // Rewrite the updated SearchParameters HTML file
  const searchParametersHtmlPath = path.join(outDir, 'pages', 'searchparameters.html');
  const searchParametersHtml = fs.readFileSync(searchParametersHtmlPath, 'utf8');
  let updatedSearchParametersHtml = searchParametersHtml.replace('<searchparameters-go-here/>', htmlSearchParameters.join(''));
  fs.writeFileSync(searchParametersHtmlPath, updatedSearchParametersHtml, 'utf8');

  // Rewrite the updated OperationDefinitions HTML file
  const operationDefinitionsHtmlPath = path.join(outDir, 'pages', 'operationdefinitions.html');
  const operationDefinitionsHtml = fs.readFileSync(operationDefinitionsHtmlPath, 'utf8');
  let updatedOperationDefinitionsHtml = operationDefinitionsHtml.replace('<operationdefinitions-go-here/>', htmlOperationDefinitions.join(''));
  fs.writeFileSync(operationDefinitionsHtmlPath, updatedOperationDefinitionsHtml, 'utf8');

  // Rewrite the updated CapabilityStstements HTML file
  const capabilityStatementsHtmlPath = path.join(outDir, 'pages', 'capabilitystatements.html');
  const capabilityStatementsHtml = fs.readFileSync(capabilityStatementsHtmlPath, 'utf8');
  let updatedCapabilityStatementsHtml = capabilityStatementsHtml.replace('<capabilitystatements-go-here/>', htmlCapabilityStatements.join(''));
  fs.writeFileSync(capabilityStatementsHtmlPath, updatedCapabilityStatementsHtml, 'utf8');

  // Rewrite the updated Conformances HTML file
  const conformancesHtmlPath = path.join(outDir, 'pages', 'conformances.html');
  const conformancesHtml = fs.readFileSync(conformancesHtmlPath, 'utf8');
  let updatedConformancesHtml = conformancesHtml.replace('<conformances-go-here/>', htmlConformances.join(''));
  fs.writeFileSync(conformancesHtmlPath, updatedConformancesHtml, 'utf8');

  // Rewrite the update Examples HTML file
  const examplesHtmlPath = path.join(outDir, 'pages', 'examples.html');
  const examplesHtml = fs.readFileSync(examplesHtmlPath, 'utf8');
  let updatedExamplesHtml = examplesHtml.replace('<examples-go-here/>', htmlExamples.join(''));
  fs.writeFileSync(examplesHtmlPath, updatedExamplesHtml, 'utf8');

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
  if (htmlSearchParameters.length === 0) {
    const searchParametersItem = '<li><a href="searchparameters.html">Search Parameters</a></li>';
    navbarHtml = navbarHtml.replace(searchParametersItem, '<!-- no search parameters -->');
  }
  if (htmlOperationDefinitions.length === 0) {
    const operationDefinitionsItem = '<li><a href="operationdefinitions.html">Operation Definitions</a></li>';
    navbarHtml = navbarHtml.replace(operationDefinitionsItem, '<!-- no operation definitions -->');
  }
  const capabilityStatementsItem = '<li><a href="capabilitystatements.html">Capability Statements</a></li>';
  if (htmlCapabilityStatements.length === 0 && htmlConformances.length === 0) {
    navbarHtml = navbarHtml.replace(capabilityStatementsItem, '<!-- no conformance / capability statements -->');
  } else if (htmlConformances.length > 0) {
    // We can only have capability statements (STU3+) *or* conformance statements (DSTU2),
    // so if we have conformance, we know we don't have capability.  Replace it.
    navbarHtml = navbarHtml.replace(capabilityStatementsItem, '<li><a href="conformances.html">Conformance Statements</a></li>');
  }
  const historyItem = '<history-link-goes-here/>';
  if (config.implementationGuide.historyLink && config.implementationGuide.historyLink.trim().length > 0) {
    navbarHtml = navbarHtml.replace(historyItem, `<li><a href="${config.implementationGuide.historyLink.trim()}">History</a></li>`);
  } else {
    navbarHtml = navbarHtml.replace(historyItem, '');
  }
  if (htmlExamples.length === 0) {
    const examplesItem = '<li><a href="examples.html">Examples</a></li>';
    navbarHtml = navbarHtml.replace(examplesItem, '<!-- no examples -->')
  }
  fs.writeFileSync(navbarPath, navbarHtml);
}

function getValueSetInfo(url, definitionValueSets) {
  let valueSetUrl;
  let valueSetName;
  let valueSetDescription;

  // In R4, versions are appended to the end of the URL (E.g., http://hl7.org/fhir/ValueSet/medication-status|4.0.0).
  // For this use, drop the version
  if (url.indexOf('|') > 0) {
    url = url.slice(0, url.indexOf('|'));
  }

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

function removeSHRMappings(sd, baseSD) {
  sd = common.cloneJSON(sd);
  // First go through and remove all the SHR mappings from the snapshot
  sd.snapshot.element.forEach(el => {
    if (el.mapping && el.mapping.length > 0) {
      el.mapping = el.mapping.filter(m => m.identity != 'shr');
      if (el.mapping.length === 0) {
        delete el.mapping;
      }
    }
  });
  // Then remove all SHR mappings from the differential
  sd.differential.element.forEach(el => {
    if (el.mapping && el.mapping.length > 0) {
      el.mapping = el.mapping.filter(m => m.identity != 'shr');
      if (el.mapping.length === 0) {
        delete el.mapping;
      }
    }
  });
  // Now compact the structure definition since the removal of mappings may eliminate the need for
  // several of the differential elements and/or previously "unrolled" snapshot elements
  common.compactStructureDefinition(sd, baseSD);
  // Finally return the new sd
  return sd;
}

module.exports = {exportIG, setLogger};
