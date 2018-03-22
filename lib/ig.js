const path = require('path');
const fs = require('fs-extra');
const common = require('./common');

function exportIG(specifications, fhirResults, outDir, configuration = {}, specPath) {

  const config = configuration;

  // Copy the static parts of the IG
  fs.copySync(path.join(__dirname, 'ig_files'), outDir);

  const igControlPath = path.join(outDir, 'ig.json');
  const igControl = fs.readJsonSync(igControlPath);
  const xmlResources = [];
  const htmlEntryProfiles = [];
  const htmlSupportProfiles = [];
  const htmlExtensions = [];
  const htmlValueSets = [];
  const htmlCodeSystems = [];
  const htmlEntryModels = [];
  const htmlSupportModels = [];

  //Configure igControl to use configuration specifications
  igControl.canonicalBase = igControl.canonicalBase.replace('<ig-url-go-here>',config.fhirURL);

  //Rewrite base files to use project names
  const igIndexHtmlPath = path.join(outDir, 'pages','index.html');
  const igIndexHtml = fs.readFileSync(igIndexHtmlPath, 'utf8');
  const igIndexContentPath = path.join(specPath, config.igIndexContent);
  var igIndexContent;
  try {
    igIndexContent = fs.readFileSync(igIndexContentPath, 'utf8');
  } catch (error) {
    igIndexContent =
`<p> This is a ${config.projectName} FHIR implementation guide. </p>`;
    fs.writeFileSync(igIndexContentPath, igIndexContent, 'utf8');
  }

  fs.writeFileSync(igIndexHtmlPath, igIndexHtml.replace('<igIndexContent-go-here>', igIndexContent), 'utf8');

  const igHeaderPath = path.join(outDir, 'pages', '_includes', 'header.html');
  const igHeader = fs.readFileSync(igHeaderPath, 'utf8');
  fs.writeFileSync(igHeaderPath, igHeader.replace(/<project-name-go-here>/g, config.projectName), 'utf8');

  const igNavbarPath = path.join(outDir, 'pages', '_includes', 'navbar.html');
  const igNavbar = fs.readFileSync(igNavbarPath, 'utf8');
  fs.writeFileSync(igNavbarPath, igNavbar.replace(/<project-name-go-here>/g, config.projectName), 'utf8');


  // For each profile, extension, value set, and code system
  // 1. Copy it into the corresponding resources subfolder
  // 2. Add it to the IG JSON controle file
  // 3. Add it to the IG XML file
  // 4. Add it to the corresponding HTML listing file
  // 5. Create the mapping xhtml file (profiles only)

  // The entry map is used to determine if a profile or model is an entry (primary) or not (supporting)
  const entryMap = new Map();
  for (const entry of specifications.dataElements.entries) {
    entryMap.set(common.fhirID(entry.identifier), true);
    entryMap.set(common.fhirID(entry.identifier, 'model'), true);
  }

  fhirResults.profiles.sort(byName);
  const sdPath = path.join(outDir, 'resources');
  fs.ensureDirSync(sdPath);
  for (const profile of fhirResults.profiles) {
    fs.writeFileSync(path.join(sdPath, `structuredefinition-${profile.id}.json`), JSON.stringify(profile, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${profile.id}`] = {
      'base': `StructureDefinition-${profile.id}.html`
    };
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="StructureDefinition/${profile.id}" />
                <display value="${profile.title}" />
            </sourceReference>
        </resource>
        `);

    const name = profile.title.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Profile$/, '');
    const htmlSnippet =
    `<tr>
      <td><a href="StructureDefinition-${profile.id}.html">${name}</a></td>
      <td><a href="http://hl7.org/fhir/STU3/${profile.type.toLowerCase()}.html">${profile.type}</a></td>
      <td>${common.escapeHTML(profile.description)}</td>
    </tr>
    `;
    if (entryMap.has(profile.id)) {
      htmlEntryProfiles.push(htmlSnippet);
    } else {
      htmlSupportProfiles.push(htmlSnippet);
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

  fhirResults.extensions.sort(byName);
  for (const extension of fhirResults.extensions) {
    fs.writeFileSync(path.join(sdPath, `structuredefinition-${extension.id}.json`), JSON.stringify(extension, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${extension.id}`] = {
      'base': `StructureDefinition-${extension.id}.html`
    };
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="StructureDefinition/${extension.id}" />
                <display value="${extension.title}" />
            </sourceReference>
        </resource>
        `);
    const name = extension.title.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Extension$/, '');
    htmlExtensions.push(
    `<tr>
      <td><a href="StructureDefinition-${extension.id}.html">${name}</a></td>
      <td>${common.escapeHTML(extension.description)}</td>
    </tr>
    `);

    // Mappings don't really apply to extensions, but we have to create a file to keep Jekyll happy
    const mapPath = path.join(outDir, 'pages', '_includes', `${extension.id}-cameo-mapping.xhtml`);
    fs.writeFileSync(mapPath, '', 'utf8');
  }

  fhirResults.valueSets.sort(byName);
  const vsPath = path.join(outDir, 'resources');
  fs.ensureDirSync(vsPath);
  for (const valueSet of fhirResults.valueSets) {
    fs.writeFileSync(path.join(vsPath, `valueset-${valueSet.id}.json`), JSON.stringify(valueSet, null, 2), 'utf8');
    igControl.resources[`ValueSet/${valueSet.id}`] = {
      'base': `ValueSet-${valueSet.id}.html`
    };
    if (!valueSet.url.startsWith(config.fhirURL)) {
      igControl['special-urls'].push(valueSet.url);
    }
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="ValueSet/${valueSet.id}" />
                <display value="${valueSet.title}" />
            </sourceReference>
        </resource>
        `);

    const name = valueSet.title.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ ValueSet$/, '');
    htmlValueSets.push(
    `<tr>
      <td><a href="ValueSet-${valueSet.id}.html">${name}</a></td>
      <td>${common.escapeHTML(valueSet.description)}</td>
    </tr>
    `);
  }

  fhirResults.codeSystems.sort(byName);
  const csPath = path.join(outDir, 'resources');
  fs.ensureDirSync(csPath);
  for (const codeSystem of fhirResults.codeSystems) {
    fs.writeFileSync(path.join(csPath, `codesystem-${codeSystem.id}.json`), JSON.stringify(codeSystem, null, 2), 'utf8');
    igControl.resources[`CodeSystem/${codeSystem.id}`] = {
      'base': `CodeSystem-${codeSystem.id}.html`
    };
    if (!codeSystem.url.startsWith(config.fhirURL)) {
      igControl['special-urls'].push(codeSystem.url);
    }
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="CodeSystem/${codeSystem.id}" />
                <display value="${codeSystem.title}" />
            </sourceReference>
        </resource>
        `);

    const name = codeSystem.title.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ CodeSystem$/, '');
    htmlCodeSystems.push(
    `<tr>
      <td><a href="CodeSystem-${codeSystem.id}.html">${name}</a></td>
      <td>${common.escapeHTML(codeSystem.description)}</td>
    </tr>
    `);
  }

  if (config.igLogicalModels) {
    fhirResults.models.sort(byName);
    for (const model of fhirResults.models) {
      fs.writeFileSync(path.join(sdPath, `structuredefinition-${model.id}.json`), JSON.stringify(model, null, 2), 'utf8');
      igControl.resources[`StructureDefinition/${model.id}`] = {
        'base': `StructureDefinition-${model.id}.html`,
        'template-base': 'sd-logical.html',
        'pseudo-json': false,
        'pseudo-xml': false,
        'pseudo-ttl': false
      };
      xmlResources.push(`<resource>
              <example value="false" />
              <sourceReference>
                  <reference value="StructureDefinition/${model.id}" />
                  <display value="${model.name}" />
              </sourceReference>
          </resource>
          `);

      const name = model.title.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Logical Model$/, '');
      const htmlSnippet =
      `<tr>
        <td><a href="StructureDefinition-${model.id}.html">${name}</a></td>
        <td>${common.escapeHTML(model.description)}</td>
      </tr>
      `;
      if (entryMap.has(model.id)) {
        htmlEntryModels.push(htmlSnippet);
      } else {
        htmlSupportModels.push(htmlSnippet);
      }

      // Mappings don't really apply to models, but we have to create a file to keep Jekyll happy
      const mapPath = path.join(outDir, 'pages', '_includes', `${model.id}-cameo-mapping.xhtml`);
      fs.writeFileSync(mapPath, '', 'utf8');
    }
  }

  // Copy over the US Core validator file.  This is needed due to a bug in the published US-Core.
  // See: https://chat.fhir.org/#narrow/stream/implementers/topic/Publisher.20broken.20when.20using.20.20uscore.20dependency.3F
  // See: https://chat.fhir.org/#narrow/stream/committers/subject/IG.20Publisher.20Error/near/136497
  fs.copySync(path.join(__dirname, 'definitions', 'FHIR_STU_3', 'IGs', 'US_Core', 'validator.pack'),
    path.join(outDir, 'uscore', 'validator.pack'));

  // Rewrite the updated IG JSON control file
  fs.writeFileSync(igControlPath, JSON.stringify(igControl, null, 2), 'utf8');

  // Rewrite the updated IG XML file
  const igXmlPath = path.join(outDir, 'resources', 'ig.xml');
  const igXml = fs.readFileSync(igXmlPath, 'utf8');
  fs.writeFileSync(igXmlPath, igXml.replace('<resources-go-here/>', xmlResources.join(''))
                                   .replace(/<project-name-go-here>/g, config.projectName)
                                   .replace('<ig-url-go-here>', config.fhirURL), 'utf8');

  // Rewrite the updated Profiles HTML file
  const profilesHtmlPath = path.join(outDir, 'pages', 'profiles.html');
  const profilesHtml = fs.readFileSync(profilesHtmlPath, 'utf8');
  fs.writeFileSync(profilesHtmlPath, profilesHtml.replace('<entry-profiles-go-here/>', htmlEntryProfiles.join(''))
                                                 .replace('<support-profiles-go-here/>', htmlSupportProfiles.join(''))
                                                 .replace('<project-shorthand-go-here/>', config.projectShorthand), 'utf8');

  // Rewrite the updated Extensions HTML file
  const extensionsHtmlPath = path.join(outDir, 'pages', 'extensions.html');
  const extensionsHtml = fs.readFileSync(extensionsHtmlPath, 'utf8');
  fs.writeFileSync(extensionsHtmlPath, extensionsHtml.replace('<extensions-go-here/>', htmlExtensions.join(''))
                                                     .replace('<project-shorthand-go-here/>', config.projectShorthand), 'utf8');

  // Rewrite the updated ValueSets HTML file
  const valueSetsHtmlPath = path.join(outDir, 'pages', 'valuesets.html');
  const valueSetsHtml = fs.readFileSync(valueSetsHtmlPath, 'utf8');
  fs.writeFileSync(valueSetsHtmlPath, valueSetsHtml.replace('<valueSets-go-here/>', htmlValueSets.join(''))
                                                   .replace('<project-shorthand-go-here/>', config.projectShorthand), 'utf8');

  // Rewrite the updated CodeSystems HTML file
  const codeSystemsHtmlPath = path.join(outDir, 'pages', 'codesystems.html');
  const codeSystemsHtml = fs.readFileSync(codeSystemsHtmlPath, 'utf8');
  fs.writeFileSync(codeSystemsHtmlPath, codeSystemsHtml.replace('<codeSystems-go-here/>', htmlCodeSystems.join(''))
                                                       .replace('<project-shorthand-go-here/>', config.projectShorthand), 'utf8');

  // Rewrite the updated Models HTML file
  const modelsHtmlPath = path.join(outDir, 'pages', 'logical.html');
  const modelsHtml = fs.readFileSync(modelsHtmlPath, 'utf8');
  fs.writeFileSync(modelsHtmlPath, modelsHtml.replace('<entry-models-go-here/>', htmlEntryModels.join(''))
                                             .replace('<support-models-go-here/>', htmlSupportModels.join(''))
                                             .replace('<project-shorthand-go-here/>', config.projectShorthand), 'utf8');
  if (!config.igLogicalModels || !config.igModelDoc) {
    const navbarPath = path.join(outDir, 'pages', '_includes', 'navbar.html');
    let navbarHtml = fs.readFileSync(navbarPath, 'utf8');
    if (!config.igLogicalModels) {
      const modelsItem = '<li><a href="logical.html">Logical Models</a></li>';
      navbarHtml = navbarHtml.replace(modelsItem, '<!-- no logical models -->');
    }
    if (!config.igModelDoc) {
      const browserItem = '<li><a href="modeldoc/index.html" target="_blank">Launch Model Browser</a></li>';
      navbarHtml = navbarHtml.replace(browserItem, '<!-- no model browser -->');
    }
    fs.writeFileSync(navbarPath, navbarHtml);
  }
}

/* COMMENTED OUT BECAUSE WE MAY INTRODUCE IN NEAR-FUTURE.  IF IT'S AFTER JUL 1 2018 AND YOU STILL SEE THIS, DELETE IT!

function getNamespaceFromID(id, config) {
  const matches = /^(([a-z][^-]*-)+)([A-Z].*)$/.exec(id);
  if (matches) {
    let parts = matches[1].split('-').filter(s => s.length);
    if (parts[0].toLowerCase() === config.projectShorthand) {
      parts = parts.slice(1);
    } else if (parts[0] === 'shr') {
      parts[0] = 'SHR';
    }
    return parts.map(s => common.capitalize(s)).join(' ');
  }
  return '';
}

const PRIMITIVE_PREFIX = 'primitive-';

function byID(a, b) {
  if (a.id.startsWith(PRIMITIVE_PREFIX) !== b.id.startsWith(PRIMITIVE_PREFIX)) {
    return a.id.startsWith(PRIMITIVE_PREFIX) ? 1 : -1;
  } else if (a.id < b.id) {
    return -1;
  } else if (a.id > b.id) {
    return 1;
  }
  return 0;
}

*/

function byName(a, b) {
  if (a.name < b.name) {
    return -1;
  } else if (a.name > b.name) {
    return 1;
  }
  return 0;
}

module.exports = {exportIG};