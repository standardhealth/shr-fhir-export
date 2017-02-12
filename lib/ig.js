const path = require('path');
const fs = require('fs-extra');

function exportIG(fhirResults, outDir) {
  // Copy the static parts of the IG
  fs.copySync(`${__dirname}/ig_files`, outDir);

  const igControlPath = path.join(outDir, 'shr.json');
  const igControl = fs.readJsonSync(igControlPath);
  const igXmlPath = path.join(outDir, 'resources', 'ImplementationGuide', 'ImplementationGuide_1.xml');
  const igXml = fs.readFileSync(igXmlPath, 'utf8');
  const xmlResources = [];

  // For each profile and extension:
  // 1. Copy it into resources/StructureDefinition
  // 2. Add it to the IG JSON controle file
  // 3. Add it to the IG XML file
  const sdPath = path.join(outDir, 'resources', 'StructureDefinition');
  for (const profile of fhirResults.profiles) {
    fs.writeFileSync(path.join(sdPath, `${profile.id}.json`), JSON.stringify(profile, null, 2));
    igControl.resources[`StructureDefinition/${profile.id}`] = {
      'template-base': 'instance-template-sd-no-example.html',
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
  }
  for (const extension of fhirResults.extensions) {
    fs.writeFileSync(path.join(sdPath, `${extension.id}.json`), JSON.stringify(extension, null, 2));
    igControl.resources[`StructureDefinition/${extension.id}`] = {
      'template-base': 'instance-template-sd-no-example.html',
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
  }

  // Rewrite the updated IG JSON control file
  fs.writeFileSync(igControlPath, JSON.stringify(igControl, null, 2));

  // Rewrite the updated IG XML file
  fs.writeFileSync(igXmlPath, igXml.replace('<resources-go-here/>', xmlResources.join('')));
}

module.exports = {exportIG};