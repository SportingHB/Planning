const url = 'https://raw.githubusercontent.com/SportingHB/PlanningSP/main/PlanningSP.pdf';

let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;

const canvas = document.getElementById('pdf-canvas');
const ctx = canvas.getContext('2d');

// Funzione per caricare il PDF
pdfjsLib.getDocument(url).promise.then(function (doc) {
  pdfDoc = doc;
  totalPages = pdfDoc.numPages;
  renderPage(currentPage);
});

// Funzione per disegnare la pagina
function renderPage(pageNum) {
  pdfDoc.getPage(pageNum).then(function (page) {
    const viewport = page.getViewport({ scale: 1.5 });
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    page.render({
      canvasContext: ctx,
      viewport: viewport
    });

    document.getElementById('page-num').textContent = `Pagina ${currentPage}`;
  });
}

// Funzione per cambiare la pagina
function changePage(offset) {
  const newPage = currentPage + offset;
  if (newPage > 0 && newPage <= totalPages) {
    currentPage = newPage;
    renderPage(currentPage);
  }
}
