import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';


export class ImagePreloader {
    private imageBase64DataCache = new Map<string, string>();
    private imageFiles: string[] = [];
    private currentIndex = 0;
    private preloadRadius = { next: 3, prev: 2 }; // Default values
    private isPreloading = false;
    private keepBuffer = 5; // Number of images to keep in cache around current position

    constructor(private webview: vscode.Webview) {}

    // Initialize with directory and set current image
    public async initialize(directoryPath: string, currentImagePath: string, nextCount = 3, prevCount = 2): Promise<void> {
        this.preloadRadius = { next: nextCount, prev: prevCount };
        
        // Get all image files from directory
        const files = await fs.promises.readdir(directoryPath);
        this.imageFiles = files
            .filter(file => /\.(jpg|jpeg|png|bmp|webp)$/i.test(file))
            .map(file => path.join(directoryPath, file))
            .sort(); // Sort for consistent ordering

        // Find current image index
        this.currentIndex = this.imageFiles.findIndex(file => file === currentImagePath);
        if (this.currentIndex === -1) {
            this.currentIndex = 0;
        }

        // Start preloading around current image
        await this.preloadAroundCurrent();
    }

    // Get HTML for current image (instant if cached)
    public getCurrentImageHTML(): string {
        const currentImage = this.imageFiles[this.currentIndex];
        if (!currentImage) {return '<div>No image found</div>';}

        const cached = this.imageBase64DataCache.get(currentImage);
        if (cached) {
            return `<img src="${cached}" alt="Current Image" class="main-image" id="mainImage" />`;
        }

        // Fallback to webview URI if not cached yet
        const imageUri = vscode.Uri.file(currentImage);
        const webviewUri = this.webview.asWebviewUri(imageUri);
        return `<img src="${webviewUri}" alt="Current Image" class="main-image" id="mainImage" />`;
    }

    // Navigate to next image
    public async goToNext(): Promise<string> {
        if (this.currentIndex < this.imageFiles.length - 1) {
            this.currentIndex++;
            await this.preloadAroundCurrent();
        }
        return this.getCurrentImageHTML();
    }

    // Navigate to previous image
    public async goToPrevious(): Promise<string> {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            await this.preloadAroundCurrent();
        }
        return this.getCurrentImageHTML();
    }

    // Jump to specific index
    public async goToIndex(index: number): Promise<string> {
        if (index >= 0 && index < this.imageFiles.length) {
            this.currentIndex = index;
            await this.preloadAroundCurrent();
        }
        return this.getCurrentImageHTML();
    }

    // Get current image info
    public getCurrentImageInfo(): { path: string; index: number; total: number; filename: string } {
        const currentPath = this.imageFiles[this.currentIndex] || '';
        return {
            path: currentPath,
            index: this.currentIndex,
            total: this.imageFiles.length,
            filename: path.basename(currentPath)
        };
    }

    // Preload images around current position
    private async preloadAroundCurrent(): Promise<void> {
        if (this.isPreloading) {return;}
        this.isPreloading = true;

        try {
            const imagesToPreload: string[] = [];
            
            // Add current image
            imagesToPreload.push(this.imageFiles[this.currentIndex]);
            
            // Add next images
            for (let i = 1; i <= this.preloadRadius.next; i++) {
                const nextIndex = this.currentIndex + i;
                if (nextIndex < this.imageFiles.length) {
                    imagesToPreload.push(this.imageFiles[nextIndex]);
                }
            }
            
            // Add previous images
            for (let i = 1; i <= this.preloadRadius.prev; i++) {
                const prevIndex = this.currentIndex - i;
                if (prevIndex >= 0) {
                    imagesToPreload.push(this.imageFiles[prevIndex]);
                }
            }

            // Preload images that aren't already cached
            const uncachedImages = imagesToPreload.filter(img => !this.imageBase64DataCache.has(img));
            
            if (uncachedImages.length > 0) {
                await this.preloadImages(uncachedImages);
                console.log(`Preloaded ${uncachedImages.length} images around index ${this.currentIndex}`);
            }

            // Clean up old cached images to manage memory
            this.cleanupDistantImages();
            
        } finally {
            this.isPreloading = false;
        }
    }

    // Preload specific images
    private async preloadImages(imagePaths: string[]): Promise<void> {
        const loadPromises = imagePaths.map(async (imagePath) => {
            try {
                const buffer = await fs.promises.readFile(imagePath);
                const base64 = buffer.toString('base64');
                const mimeType = this.getMimeType(imagePath);
                const dataUrl = `data:${mimeType};base64,${base64}`;
                this.imageBase64DataCache.set(imagePath, dataUrl);
            } catch (error) {
                console.warn(`Failed to preload image: ${imagePath}`, error);
            }
        });

        await Promise.all(loadPromises);
    }

    // Clean up images that are far from current position to manage memory
    private cleanupDistantImages(): void {
        const imagesToKeep = new Set<string>();
        
        // Mark images to keep
        for (let i = Math.max(0, this.currentIndex - (this.preloadRadius.prev + this.keepBuffer)); 
             i <= Math.min(this.imageFiles.length - 1, this.currentIndex + (this.preloadRadius.next + this.keepBuffer)); 
             i++) {
            imagesToKeep.add(this.imageFiles[i]);
        }

        // Remove distant images from cache
        for (const [imagePath] of this.imageBase64DataCache) {
            if (!imagesToKeep.has(imagePath)) {
                this.imageBase64DataCache.delete(imagePath);
            }
        }
    }

    // Get MIME type for image
    private getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: { [key: string]: string } = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp'
        };
        return mimeTypes[ext] || 'image/jpeg';
    }

    // Get cache status for debugging
    public getCacheStatus(): { cached: number; total: number; currentCached: boolean } {
        const currentImage = this.imageFiles[this.currentIndex];
        return {
            cached: this.imageBase64DataCache.size,
            total: this.imageFiles.length,
            currentCached: currentImage ? this.imageBase64DataCache.has(currentImage) : false
        };
    }
}

// // Usage in your extension
// export class YOLOImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
//     private imagePreloader?: ImagePreloader;

//     public async resolveCustomEditor(
//         document: YOLOImageDocument,
//         webviewPanel: vscode.WebviewPanel,
//         token: vscode.CancellationToken
//     ): Promise<void> {
//         // Initialize webview
//         webviewPanel.webview.options = {
//             enableScripts: true,
//             localResourceRoots: [vscode.Uri.file(path.dirname(document.uri.fsPath))]
//         };

//         // Initialize image preloader
//         this.imagePreloader = new ImagePreloader(webviewPanel.webview);
        
//         const directoryPath = path.dirname(document.uri.fsPath);
//         await this.imagePreloader.initialize(
//             directoryPath, 
//             document.uri.fsPath, 
//             3, // preload 3 next images
//             2  // preload 2 previous images
//         );

//         // Set initial HTML
//         webviewPanel.webview.html = this.getWebviewHTML();

//         // Setup message handling
//         this.setupMessageHandling(webviewPanel);
//     }

//     private setupMessageHandling(webviewPanel: vscode.WebviewPanel): void {
//         webviewPanel.webview.onDidReceiveMessage(async (message) => {
//             if (!this.imagePreloader) {return;}

//             switch (message.command) {
//                 case 'nextImage':
//                     const nextHTML = await this.imagePreloader.goToNext();
//                     const nextInfo = this.imagePreloader.getCurrentImageInfo();
//                     webviewPanel.webview.postMessage({
//                         command: 'updateImage',
//                         html: nextHTML,
//                         info: nextInfo
//                     });
//                     break;

//                 case 'prevImage':
//                     const prevHTML = await this.imagePreloader.goToPrevious();
//                     const prevInfo = this.imagePreloader.getCurrentImageInfo();
//                     webviewPanel.webview.postMessage({
//                         command: 'updateImage',
//                         html: prevHTML,
//                         info: prevInfo
//                     });
//                     break;

//                 case 'gotoImage':
//                     const gotoHTML = await this.imagePreloader.goToIndex(message.index);
//                     const gotoInfo = this.imagePreloader.getCurrentImageInfo();
//                     webviewPanel.webview.postMessage({
//                         command: 'updateImage',
//                         html: gotoHTML,
//                         info: gotoInfo
//                     });
//                     break;

//                 case 'getCacheStatus':
//                     const status = this.imagePreloader.getCacheStatus();
//                     webviewPanel.webview.postMessage({
//                         command: 'cacheStatus',
//                         status: status
//                     });
//                     break;
//             }
//         });
//     }

//     private getWebviewHTML(): string {
//         const initialHTML = this.imagePreloader?.getCurrentImageHTML() || '';
//         const initialInfo = this.imagePreloader?.getCurrentImageInfo() || { index: 0, total: 0, filename: '' };

//         return `
//         <!DOCTYPE html>
//         <html>
//         <head>
//             <style>
//                 body { margin: 0; font-family: Arial, sans-serif; }
//                 .container { display: flex; flex-direction: column; height: 100vh; }
//                 .toolbar { background: #f0f0f0; padding: 10px; display: flex; gap: 10px; align-items: center; }
//                 .image-container { flex: 1; display: flex; align-items: center; justify-content: center; }
//                 .main-image { max-width: 100%; max-height: 100%; }
//                 button { padding: 5px 10px; }
//                 .info { margin-left: auto; }
//             </style>
//         </head>
//         <body>
//             <div class="container">
//                 <div class="toolbar">
//                     <button onclick="prevImage()">← Previous</button>
//                     <button onclick="nextImage()">Next →</button>
//                     <span id="info">${initialInfo.index + 1} / ${initialInfo.total} - ${initialInfo.filename}</span>
//                     <div class="info">
//                         <span id="cacheInfo">Loading...</span>
//                     </div>
//                 </div>
//                 <div class="image-container" id="imageContainer">
//                     ${initialHTML}
//                 </div>
//             </div>
            
//             <script>
//                 const vscode = acquireVsCodeApi();
                
//                 function nextImage() {
//                     vscode.postMessage({ command: 'nextImage' });
//                 }
                
//                 function prevImage() {
//                     vscode.postMessage({ command: 'prevImage' });
//                 }
                
//                 // Keyboard navigation
//                 document.addEventListener('keydown', (e) => {
//                     if (e.key === 'ArrowRight') nextImage();
//                     if (e.key === 'ArrowLeft') prevImage();
//                 });
                
//                 // Handle messages from extension
//                 window.addEventListener('message', (e) => {
//                     const message = e.data;
//                     if (message.command === 'updateImage') {
//                         document.getElementById('imageContainer').innerHTML = message.html;
//                         const info = message.info;
//                         document.getElementById('info').textContent = 
//                             \`\${info.index + 1} / \${info.total} - \${info.filename}\`;
//                     }
//                     if (message.command === 'cacheStatus') {
//                         document.getElementById('cacheInfo').textContent = 
//                             \`Cached: \${message.status.cached}\`;
//                     }
//                 });
                
//                 // Request initial cache status
//                 vscode.postMessage({ command: 'getCacheStatus' });
//             </script>
//         </body>
//         </html>`;
//     }
// }