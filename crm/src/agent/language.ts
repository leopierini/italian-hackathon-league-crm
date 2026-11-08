// Tiny language guess (English vs Italian) from common words: tells the model which language to
// reply in, and picks the language of the fallback replies.
const english = new Set(("the and please can could would you your what how many much does do did have has show list which who when where "
  + "is are of for to with my our customers customer company companies deal deals won lost mark create add note task call revenue this that "
  + "it me we all from by open tickets ticket set change update delete next week month year today tomorrow any there an").split(" "));
const italian = new Set(("il lo la gli le di da del dello della dei degli delle che per con un una uno quanto quanti quante quali quale "
  + "abbiamo ho hai ha segna come trattativa trattative miei mie mio mia è nel nella nei crea mi sono tra fra cliente clienti azienda aziende "
  + "fatturato perché non sì grazie anche dimmi aggiungi nota richiamare vinta persa assegna inseriscili allego ricordami oggi domani "
  + "settimana mese anno sul sulla alla al ai questo questa questi").split(" "));

function score(text: string): number {
  let total = 0;
  for (const word of text.toLowerCase().match(/[a-zàèéìòù]+/g) ?? []) total += english.has(word) ? 1 : italian.has(word) ? -1 : 0;
  return total;
}

export const looksEnglish = (text: string) => score(text) > 0;
export const looksItalian = (text: string) => score(text) < 0;
