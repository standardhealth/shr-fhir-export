const path = require('path');
const fs = require('fs-extra');
const common = require('./common');

function exportIG(fhirResults, outDir, configuration = [], specPath) {

  const config = configuration;

  // Copy the static parts of the IG
  fs.copySync(path.join(__dirname, 'ig_files'), outDir);

  const igControlPath = path.join(outDir, 'data.json');
  const igControl = fs.readJsonSync(igControlPath);
  const xmlResources = [];
  const htmlProfiles = [];
  const htmlExtensions = [];
  const htmlValueSets = [];
  const htmlCodeSystems = [];

  //Configure igControl to use configuration specifications
  igControl.canonicalBase = igControl.canonicalBase.replace("<ig-url-go-here>",config.fhirURL);

  //Rewrite base files to use project names
  //    index.htmls
  const rootIndexHtmlPath = path.join(outDir, 'output','index.html');
  const rootIndexHtml = fs.readFileSync(rootIndexHtmlPath, 'utf8');
  fs.writeFileSync(rootIndexHtmlPath, rootIndexHtml.replace(/<project-name-go-here>/g, config.projectName), 'utf8');

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

  fs.writeFileSync(igIndexHtmlPath, igIndexHtml.replace("<igIndexContent-go-here>", igIndexContent), 'utf8');

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
  fhirResults.profiles.sort(byID);
  const sdPath = path.join(outDir, 'resources', 'StructureDefinition');
  fs.ensureDirSync(sdPath);
  for (const profile of fhirResults.profiles) {
    fs.writeFileSync(path.join(sdPath, `${profile.id}.json`), JSON.stringify(profile, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${profile.id}`] = {
      'base': `StructureDefinition-${profile.id}.html`
    };
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="StructureDefinition/${profile.id}" />
                <display value="${profile.name}" />
            </sourceReference>
        </resource>
        `);
    const namespace = getNamespaceFromID(profile.id);

    const name = profile.name.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Profile$/, '');
    htmlProfiles.push(
    `<tr>
      <td>${namespace}</td>
      <td><a href="StructureDefinition-${profile.id}.html">${name}</a></td>
      <td><a href="http://hl7.org/fhir/STU3/${profile.type}.html">${profile.type}</a></td>
      <td>${common.escapeHTML(profile.description)}</td>
    </tr>
    `);

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

  fhirResults.extensions.sort(byID);
  for (const extension of fhirResults.extensions) {
    fs.writeFileSync(path.join(sdPath, `${extension.id}.json`), JSON.stringify(extension, null, 2), 'utf8');
    igControl.resources[`StructureDefinition/${extension.id}`] = {
      'base': `StructureDefinition-${extension.id}.html`
    };
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="StructureDefinition/${extension.id}" />
                <display value="${extension.name}" />
            </sourceReference>
        </resource>
        `);
    const namespace = getNamespaceFromID(extension.id, true);
    const name = extension.name.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ Extension$/, '');
    htmlExtensions.push(
    `<tr>
      <td>${namespace}</td>
      <td><a href="StructureDefinition-${extension.id}.html">${name}</a></td>
      <td>${common.escapeHTML(extension.description)}</td>
    </tr>
    `);

    // Mappings don't really apply to extensions, but we have to create a file to keep Jekyll happy
    const mapPath = path.join(outDir, 'pages', '_includes', `${extension.id}-cameo-mapping.xhtml`);
    fs.writeFileSync(mapPath, '', 'utf8');
  }

  fhirResults.valueSets.sort(byID);
  const vsPath = path.join(outDir, 'resources', 'ValueSet');
  fs.ensureDirSync(vsPath);
  for (const valueSet of fhirResults.valueSets) {
    fs.writeFileSync(path.join(vsPath, `${valueSet.id}.json`), JSON.stringify(valueSet, null, 2), 'utf8');
    igControl.resources[`ValueSet/${valueSet.id}`] = {
      'base': `ValueSet-${valueSet.id}.html`
    };
    igControl['special-urls'].push(valueSet.url);
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="ValueSet/${valueSet.id}" />
                <display value="${valueSet.name}" />
            </sourceReference>
        </resource>
        `);

    const namespace = getNamespaceFromID(valueSet.id, false);
    const name = valueSet.name.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ ValueSet$/, '');
    htmlValueSets.push(
    `<tr>
      <td>${namespace}</td>
      <td><a href="ValueSet-${valueSet.id}.html">${name}</a></td>
      <td>${common.escapeHTML(valueSet.description)}</td>
    </tr>
    `);
  }

  fhirResults.codeSystems.sort(byID);
  const csPath = path.join(outDir, 'resources', 'CodeSystem');
  fs.ensureDirSync(csPath);
  for (const codeSystem of fhirResults.codeSystems) {
    fs.writeFileSync(path.join(csPath, `${codeSystem.id}.json`), JSON.stringify(codeSystem, null, 2), 'utf8');
    igControl.resources[`CodeSystem/${codeSystem.id}`] = {
      'base': `CodeSystem-${codeSystem.id}.html`
    };
    igControl['special-urls'].push(codeSystem.url);
    xmlResources.push(`<resource>
            <example value="false" />
            <sourceReference>
                <reference value="CodeSystem/${codeSystem.id}" />
                <display value="${codeSystem.name}" />
            </sourceReference>
        </resource>
        `);

    const namespace = getNamespaceFromID(codeSystem.id, false);
    const name = codeSystem.name.replace(new RegExp('^' + config.projectShorthand + ' '), '').replace(/ CodeSystem$/, '');
    htmlCodeSystems.push(
    `<tr>
      <td>${namespace}</td>
      <td><a href="CodeSystem-${codeSystem.id}.html">${name}</a></td>
      <td>${common.escapeHTML(codeSystem.description)}</td>
    </tr>
    `);
  }

  // Rewrite the updated IG JSON control file
  fs.writeFileSync(igControlPath, JSON.stringify(igControl, null, 2), 'utf8');

  // Rewrite the updated IG XML file
  const igXmlPath = path.join(outDir, 'resources', 'ImplementationGuide', 'data.xml');
  const igXml = fs.readFileSync(igXmlPath, 'utf8');
  fs.writeFileSync(igXmlPath, igXml.replace('<resources-go-here/>', xmlResources.join(''))
                                   .replace(/<project-name-go-here>/g, config.projectName)
                                   .replace("<ig-url-go-here>", config.fhirURL), 'utf8');

  // Rewrite the updated Profiles HTML file
  const profilesHtmlPath = path.join(outDir, 'pages', 'profiles.html');
  const profilesHtml = fs.readFileSync(profilesHtmlPath, 'utf8');
  fs.writeFileSync(profilesHtmlPath, profilesHtml.replace('<resources-go-here/>', htmlProfiles.join(''))
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
}

function getNamespaceFromID(id, trimLastTerm=false) {
  const parts = id.split('-');
  if (parts.length == 3 && parts[0] == 'primitive') {
    return 'Primitive';
  }
  const endIndex = trimLastTerm ? parts.length-2 : parts.length-1;
  const nsParts = parts.slice(1, endIndex).map(p => p.charAt(0).toUpperCase() + p.slice(1));
  return nsParts.join(' ');
}

function byID(a, b) {
  if (a.id < b.id) {
    return -1;
  } else if (a.id > b.id) {
    return 1;
  }
  return 0;
}

module.exports = {exportIG};