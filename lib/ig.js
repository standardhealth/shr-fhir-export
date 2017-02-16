const path = require('path');
const fs = require('fs-extra');

function exportIG(fhirResults, outDir) {
  // Copy the static parts of the IG
  fs.copySync(`${__dirname}/ig_files`, outDir);

  const igControlPath = path.join(outDir, 'shr.json');
  const igControl = fs.readJsonSync(igControlPath);
  const xmlResources = [];
  const htmlProfiles = [];
  const htmlExtensions = [];

  // For each profile and extension:
  // 1. Copy it into resources/StructureDefinition
  // 2. Add it to the IG JSON controle file
  // 3. Add it to the IG XML file
  // 4. Add it to the profiles or extensions HTML file
  const sdPath = path.join(outDir, 'resources', 'StructureDefinition');
  for (const profile of fhirResults.profiles.sort(sdCompare)) {
    fs.writeFileSync(path.join(sdPath, `${profile.id}.json`), JSON.stringify(profile, null, 2));
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
    const name = profile.name.replace(/^SHR /, '').replace(/ Profile$/, '');
    htmlProfiles.push(`<tr>
          <td>${namespace}</td>
          <td><a href="StructureDefinition-${profile.id}.html">${name}</a></td>
          <td>${escapeHTML(profile.description)}</td>
        </tr>
        `);
  }
  for (const extension of fhirResults.extensions.sort(sdCompare)) {
    fs.writeFileSync(path.join(sdPath, `${extension.id}.json`), JSON.stringify(extension, null, 2));
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
    const name = extension.name.replace(/^SHR /, '').replace(/ Extension$/, '');
    htmlExtensions.push(`<tr>
          <td>${namespace}</td>
          <td><a href="StructureDefinition-${extension.id}.html">${name}</a></td>
          <td>${escapeHTML(extension.description)}</td>
        </tr>
        `);
  }

  // Rewrite the updated IG JSON control file
  fs.writeFileSync(igControlPath, JSON.stringify(igControl, null, 2));

  // Rewrite the updated IG XML file
  const igXmlPath = path.join(outDir, 'resources', 'ImplementationGuide', 'shr.xml');
  const igXml = fs.readFileSync(igXmlPath, 'utf8');
  fs.writeFileSync(igXmlPath, igXml.replace('<resources-go-here/>', xmlResources.join('')));

  // Rewrite the updated Profiles HTML file
  const profilesHtmlPath = path.join(outDir, 'pages', 'profiles.html');
  const profilesHtml = fs.readFileSync(profilesHtmlPath, 'utf8');
  fs.writeFileSync(profilesHtmlPath, profilesHtml.replace('<resources-go-here/>', htmlProfiles.join('')));

  // Rewrite the updated Extensions HTML file
  const extensionsHtmlPath = path.join(outDir, 'pages', 'extensions.html');
  const extensionsHtml = fs.readFileSync(extensionsHtmlPath, 'utf8');
  fs.writeFileSync(extensionsHtmlPath, extensionsHtml.replace('<extensions-go-here/>', htmlExtensions.join('')));
}

function sdCompare(a, b) {
  const [aID, bID] = [a.id.toLowerCase(), b.id.toLowerCase()];
  if (aID < bID) {
    return -1;
  } else if (aID > bID) {
    return 1;
  }
  return 0;
}

function getNamespaceFromID(id, isExtension=false) {
  const parts = id.split('-');
  const endIndex = isExtension ? parts.length-2 : parts.length-1;
  const nsParts = parts.slice(1, endIndex).map(p => p.charAt(0).toUpperCase() + p.slice(1));
  return nsParts.join(' ');
}

function escapeHTML(unsafe = '') {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {exportIG};