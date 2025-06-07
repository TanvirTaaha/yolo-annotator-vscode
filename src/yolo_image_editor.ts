import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Custom Editor Provider for Image Annotation
export class YOLOImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new YOLOImageEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            'yolo-annotator.imageEditor',
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        );
        return providerRegistration;
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<YOLOImageDocument> {
        return new YOLOImageDocument(uri);
    }

    public async resolveCustomEditor(
        document: YOLOImageDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Set up the webview with minimal overlay UI
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
                vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
            ]
        };

        // Create the overlay UI
        webviewPanel.webview.html = this.getOverlayHTML(webviewPanel.webview, this.context.extensionPath, document.uri);
        
        // Set up message handling
        this.setupMessageHandling(webviewPanel, document);
    }

    private getOverlayHTML(webview: vscode.Webview, extensionPath: string, imageUri: vscode.Uri): string {
        const nonce = this.getNonce();
        const imageWebviewUri = webview.asWebviewUri(imageUri);
        
        console.log("In funciton getOverlayHTML:");
        console.log("Extension URI:", extensionPath);
        console.log("Image URI:", imageUri.fsPath);

        try {
            // Path to your HTML file
            const htmlPath = vscode.Uri.file(path.join(extensionPath, 'media', 'html', 'overlay.html'));
            let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
    
            // Replace placeholders in the HTML content
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            htmlContent = htmlContent.replace(/\$\{imageWebviewUri\}/g, imageWebviewUri.toString());
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);
            
            return htmlContent;
        } catch (error) {
            console.error("Error reading HTML file:", error);
            vscode.window.showErrorMessage("Failed to load the annotation editor. Please check the extension logs for details.");
        }
        
        return "<h1>Error loading editor</h1>";
    }

    private async setupMessageHandling(webviewPanel: vscode.WebviewPanel, document: YOLOImageDocument): Promise<void> {
        // Batch operations for better remote performance
        const pendingSaves = new Map<string, any[]>();
        let saveTimeout: NodeJS.Timeout;

        const flushPendingSaves = async () => {
            if (pendingSaves.size === 0) {return;}
            
            const savePromises = Array.from(pendingSaves.entries()).map(
                ([imagePath, labels]) => this.saveLabelsForImage(imagePath, labels)
            );
            
            try {
                await Promise.all(savePromises);
                webviewPanel.webview.postMessage({ 
                    command: 'batchSaveComplete',
                    count: pendingSaves.size 
                });
            } catch (error) {
                webviewPanel.webview.postMessage({ 
                    command: 'error', 
                    message: 'Batch save failed' 
                });
            }
            
            pendingSaves.clear();
        };

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'loadLabels':
                    const labels = await this.loadLabelsForImage(message.imagePath);
                    webviewPanel.webview.postMessage({
                        command: 'labelsLoaded',
                        labels: labels
                    });
                    break;
                    
                case 'saveLabels':
                    // Batch saves for remote efficiency
                    pendingSaves.set(message.imagePath, message.labels);
                    
                    if (saveTimeout) {clearTimeout(saveTimeout);}
                    saveTimeout = setTimeout(flushPendingSaves, 2000); // Batch for 2 seconds
                    break;
                    
                case 'forceSave':
                    // Immediate save for critical operations
                    if (saveTimeout) {
                        clearTimeout(saveTimeout);
                        await flushPendingSaves();
                    }
                    break;
                    
                case 'preloadNextImage':
                    // Preload next image for smoother navigation
                    this.preloadImageLabels(message.nextImagePath);
                    break;
            }
        });
    }

    private async loadLabelsForImage(imagePath: string): Promise<any[]> {
        try {
            const labelPath = this.getLabelsPath(imagePath);
            
            // Cache check for remote performance
            const cacheKey = `labels_${path.basename(labelPath)}`;
            const cached = this.labelCache.get(cacheKey);
            if (cached && cached.mtime === await this.getFileModTime(labelPath)) {
                return cached.labels;
            }
            
            const labelContent = await fs.promises.readFile(labelPath, 'utf-8');
            const labels = labelContent
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const parts = line.split(' ');
                    return {
                        classId: parseInt(parts[0]),
                        cx: parseFloat(parts[1]),
                        cy: parseFloat(parts[2]),
                        w: parseFloat(parts[3]),
                        h: parseFloat(parts[4])
                    };
                });
            
            // Cache the result
            const mtime = await this.getFileModTime(labelPath);
            this.labelCache.set(cacheKey, { labels, mtime });
            
            return labels;
        } catch (error) {
            return [];
        }
    }

    private labelCache = new Map<string, { labels: any[], mtime: number }>();

    private async getFileModTime(filePath: string): Promise<number> {
        try {
            const stats = await fs.promises.stat(filePath);
            return stats.mtime.getTime();
        } catch {
            return 0;
        }
    }

    private async saveLabelsForImage(imagePath: string, labels: any[]): Promise<boolean> {
        try {
            const labelPath = this.getLabelsPath(imagePath);
            const content = labels
                .map(l => `${l.classId} ${l.cx.toFixed(6)} ${l.cy.toFixed(6)} ${l.w.toFixed(6)} ${l.h.toFixed(6)}`)
                .join('\n');
                
            await fs.promises.mkdir(path.dirname(labelPath), { recursive: true });
            await fs.promises.writeFile(labelPath, content);
            return true;
        } catch (error) {
            return false;
        }
    }

    private getLabelsPath(imagePath: string): string {
        const dir = path.dirname(imagePath);
        const name = path.basename(imagePath, path.extname(imagePath));
        
        // Use the predictAsumedLabelsDirPath logic here
        const labelsDir = dir.replace(/images/gi, 'labels');
        return path.join(labelsDir, `${name}.txt`);
    }

    private async preloadImageLabels(imagePath: string): Promise<void> {
        // Preload labels for performance optimization
        try {
            await this.loadLabelsForImage(imagePath);
            console.log(`Preloaded labels for: ${path.basename(imagePath)}`);
        } catch (error) {
            console.warn(`Failed to preload labels for: ${imagePath}`, error);
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}

class YOLOImageDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}

    dispose(): void {
        // Cleanup if needed
    }
}
