export interface ExtractedDocument {
  name: string;
  size: number;
  text: string;
  pageCount?: number;
  type: string;
  originalFile?: File;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function getPdfJs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjsLib, workerModule] = await Promise.all([
        import('pdfjs-dist'),
        // @ts-expect-error Vite URL import
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default;
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

export async function extractTextFromFile(file: File): Promise<ExtractedDocument> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (extension === 'pdf') {
    const [pdfjsLib, arrayBuffer] = await Promise.all([
      getPdfJs(),
      file.arrayBuffer(),
    ]);

    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
    const pdfDoc = await loadingTask.promise;

    try {
      const numPages = pdfDoc.numPages;
      const MAX_PAGES = 50;
      const pagesToProcess = Math.min(numPages, MAX_PAGES);
      const pagesText: string[] = new Array(pagesToProcess);

      // Extração concorrente em lotes de 4 páginas preservando a ordem
      const BATCH_SIZE = 4;
      for (let i = 1; i <= pagesToProcess; i += BATCH_SIZE) {
        const batchPageNumbers: number[] = [];
        for (let j = i; j < i + BATCH_SIZE && j <= pagesToProcess; j++) {
          batchPageNumbers.push(j);
        }

        await Promise.all(
          batchPageNumbers.map(async (pageNum) => {
            const page = await pdfDoc.getPage(pageNum);
            try {
              const textContent = await page.getTextContent();
              let pageStr = '';
              for (let k = 0; k < textContent.items.length; k++) {
                const item = textContent.items[k];
                if ('str' in item && item.str) {
                  if (pageStr) pageStr += ' ';
                  pageStr += item.str;
                }
              }
              pagesText[pageNum - 1] = `[Página ${pageNum}]:\n${pageStr}`;
            } finally {
              page.cleanup();
            }
          })
        );
      }

      let fullText = pagesText.join('\n\n');
      if (numPages > pagesToProcess) {
        fullText += `\n\n[... documento truncado após ${pagesToProcess} páginas para manter a fluidez do sistema ...]`;
      }

      return {
        name: file.name,
        size: file.size,
        text: fullText,
        pageCount: numPages,
        type: 'pdf',
        originalFile: file,
      };
    } finally {
      // Libertação imediata de memória e do worker do PDF.js
      await pdfDoc.cleanup();
      await loadingTask.destroy();
    }
  }

  // Para ficheiros de texto simples, markdown, csv, json, etc.
  const textContent = await file.text();
  return {
    name: file.name,
    size: file.size,
    text: textContent,
    pageCount: 1,
    type: extension || 'txt',
    originalFile: file,
  };
}
