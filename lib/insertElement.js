const escapeRegExp = require('lodash/escapeRegExp');

/**
 * Finds the intended index in the list where the element should be inserted
 */
function intendedIndexInList(element, list) {
  let i = 0;
  let lastMatchId = '';
  for (; i < list.length; i++) {
    const currentId = list[i].id;
    // If the item we're placing starts with the current item, it's a match
    // so remember the match and go to the next element in the list
    if ((new RegExp(`^${escapeRegExp(currentId)}([\\.:].+)?$`)).test(element.id)) {
      lastMatchId = currentId;
    // If it wasn't a match, but the current item is a choice (e.g., value[x]), call it
    // a match if it starts with the same root (e.g., valueString), and then go to the next element
    } else if (currentId.endsWith('[x]') && (new RegExp(`^${escapeRegExp(currentId.slice(0, -3))}[A-Z][^\\.]+(\\..+)?$`)).test(element.id)) {
      lastMatchId = currentId;
    } else {
      let stop;
      // If the next part of the item is a '.' (not a ':'), then we want to stop if the current item
      // doesn't start with the last match or is a slice of the last match (as indicated by a ':')
      if (element.id.length > lastMatchId.length && element.id[lastMatchId.length] === '.') {
        stop = ! new RegExp(`^${escapeRegExp(lastMatchId)}(\\..+)?$`).test(currentId);
      // else we want to stop if the current item doesn't start with the last match
      } else {
        stop = ! new RegExp(`^${escapeRegExp(lastMatchId)}([\\.:].+)?$`).test(currentId);
      }
      if (stop) {
        break;
      }
    }
  }
  return i;
}

/**
 * Inserts an element into its proper place in a list of elements
 */
function insertElementInList(element, list) {
  const i = intendedIndexInList(element, list);
  list.splice(i, 0, element);
}

/**
 * Inserts an element into its proper place in the snapshot element
 */
function insertElementInSnapshot(element, profile) {
  insertElementInList(element, profile.snapshot.element);
}

/**
 * Inserts an element into its proper place in the differential elements
 */
function insertElementInDifferential(element, profile) {
  insertElementInList(element, profile.differential.element);
}

module.exports = { insertElementInList, insertElementInSnapshot, insertElementInDifferential, intendedIndexInList };