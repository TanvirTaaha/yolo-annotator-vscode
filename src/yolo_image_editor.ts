import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import * as preloader from './preloader';


// Custom Editor Provider for Image Annotation
export class YOLOImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
    private imagePreloader?: preloader.ImagePreloader;
    private labelCache = new Map<string, { labels: any[], mtime: number }>();
    private classesPath = '';
    private classes = new Array<string>();

    constructor(private readonly context: vscode.ExtensionContext) { }


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

        // Initalize image preloader
        this.imagePreloader = new preloader.ImagePreloader(webviewPanel.webview);
        await this.imagePreloader.initialize(
            path.dirname(document.uri.fsPath),
            document.uri.fsPath,
            2, // previous
            5  // next
        );

        this.loadCalsses(document.uri);
        // Create the overlay UI
        webviewPanel.webview.html = this.getOverlayHTML(webviewPanel.webview, this.context.extensionPath, document.uri);

        // Set up message handling
        this.setupMessageHandling(webviewPanel, document);
    }

    private async loadCalsses(uri: vscode.Uri) {
        this.classesPath = path.join(path.dirname(uri.fsPath), 'classes.txt');
        if (!fs.existsSync(this.classesPath)) {
            this.classesPath = uri.fsPath.replace(/[\/|\\]images[\/|\\].*$/gim, path.sep + 'classes.txt');
            if (!fs.existsSync(this.classesPath)) {
                this.classesPath = this.classesPath.replace('classes.txt', 'images' + path.sep + 'classes.txt');
                if (!fs.existsSync(this.classesPath)) {
                    this.classesPath = this.classesPath.replace('classes.txt', 'labels' + path.sep + 'classes.txt');
                } else {
                    console.error("Can't find classes.txt");
                    vscode.window.showErrorMessage("Failed to load the classes.txt file. Please put it in the parent directory or images/labels folder.");
                }
            }
        }
        console.log(`Classes path found:${this.classesPath}: exists: ${fs.existsSync(this.classesPath)}`);
        this.classes = fs.readFileSync(this.classesPath, 'utf8').split('\n').filter(line => line.trim());
        console.log(`Classes parsed:${this.classes}`);
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
            // htmlContent = htmlContent.replace(/\$\{imageWebviewUri\}/g, imageWebviewUri.toString());
            // htmlContent = htmlContent.replace(/\$\{imageUri.fsPath\}/g, imageUri.fsPath);
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);

            return htmlContent;
        } catch (error) {
            console.error("Error reading HTML file:", error);
            vscode.window.showErrorMessage("Failed to load the annotation editor. Please check the extension logs for details.");
        }

        return "<h1>Error loading editor</h1>";
    }

    private async showClassInputPrompt(webview: vscode.Webview, labelIndex: number, prevClassIndex: number) {
        console.log(`Showing popup prompt for label index: ${labelIndex}`);

        if (!this.classes || this.classes.length === 0) {
            vscode.window.showErrorMessage("Class list is empty or not loaded.");
            return;
        }

        const currentClass = prevClassIndex === -1 ? '' : this.classes[prevClassIndex];
        const quickPickItems: vscode.QuickPickItem[] = [
            {
                label: currentClass,
                description: 'Currently selected'
            },
            ...this.classes
                .filter(className => className !== currentClass)
                .map(className => ({
                    label: className,
                    description: undefined
                }))];

        const selectedClass = await vscode.window.showQuickPick(quickPickItems, {
            title: 'Select class for the selected Label',
            placeHolder: 'Select or enter a class name',
            canPickMany: false,
            ignoreFocusOut: false
        });

        if (selectedClass) {
            // Post message back to the webview with selected class
            if (webview) {
                webview.postMessage({
                    command: 'updateLabelClassAfterChoice',
                    labelIndex: labelIndex,
                    className: selectedClass
                });
            } else {
                console.warn("No active webview panel to post message.");
            }
        } else {
            console.log("User cancelled class selection prompt.");
        }
    }


    private async setupMessageHandling(webviewPanel: vscode.WebviewPanel, document: YOLOImageDocument): Promise<void> {
        // Batch operations for better remote performance
        const pendingSaves = new Map<string, any[]>();
        let saveTimeout: NodeJS.Timeout;

        const flushPendingSaves = async () => {
            if (pendingSaves.size === 0) { return; }

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
                    const labels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'labelsLoaded',
                        labels: labels,
                        classes: this.classes
                    });
                    break;

                case 'saveLabels':
                    // Batch saves for remote efficiency
                    pendingSaves.set(message.imagePath, message.labels);

                    if (saveTimeout) { clearTimeout(saveTimeout); }
                    saveTimeout = setTimeout(flushPendingSaves, 2000); // Batch for 2 seconds
                    break;

                case 'forceSave':
                    // Immediate save for critical operations
                    if (saveTimeout) {
                        clearTimeout(saveTimeout);
                        await flushPendingSaves();
                    }
                    break;

                case 'getCurrentImage':
                    const currentHTML = this.imagePreloader?.getCurrentImageHTML();
                    const currentInfo = this.imagePreloader?.getCurrentImageInfo();
                    const currentLabels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'updateImage',
                        html: currentHTML,
                        info: currentInfo,
                        labels: currentLabels,
                        classes: this.classes
                    });
                    break;


                case 'nextImage':
                    const nextHTML = await this.imagePreloader?.goToNext();
                    const nextInfo = this.imagePreloader?.getCurrentImageInfo();
                    const nextLabels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'updateImage',
                        html: nextHTML,
                        info: nextInfo,
                        labels: nextLabels,
                        classes: this.classes 
                    });
                    break;

                case 'prevImage':
                    const prevHTML = await this.imagePreloader?.goToPrevious();
                    const prevInfo = this.imagePreloader?.getCurrentImageInfo();
                    const prevLabels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'updateImage',
                        html: prevHTML,
                        info: prevInfo,
                        labels: prevLabels,
                        classes: this.classes
                    });
                    break;

                case 'gotoImage':
                    const gotoHTML = await this.imagePreloader?.goToIndex(message.index);
                    const gotoInfo = this.imagePreloader?.getCurrentImageInfo();
                    const gotoLabels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'updateImage',
                        html: gotoHTML,
                        info: gotoInfo,
                        labels: gotoLabels,
                        classes: this.classes
                    });
                    break;

                case 'getCacheStatus':
                    const status = this.imagePreloader?.getCacheStatus();
                    webviewPanel.webview.postMessage({
                        command: 'cacheStatus',
                        status: status
                    });
                    break;

                case 'editClassOfLabel':
                    this.showClassInputPrompt(webviewPanel.webview, message.labelIndex, message.prevClassIndex);
                    break;
            }
        });
    }

    // private async loadLabelsForImage(imagePath: string): Promise<any[]> {
    //     try {
    //         console.log(`loadLabelsForImage: ${imagePath}`);
    //         const labelPath = this.getLabelsPath(imagePath);
    //         console.log(`loadLabelsForImage: labelPath:${labelPath}`);

    //         // Cache check for remote performance
    //         const cacheKey = `labels_${path.basename(labelPath)}`;
    //         const cached = this.labelCache.get(cacheKey);
    //         if (cached && cached.mtime === await this.getFileModTime(labelPath)) {
    //             return cached.labels;
    //         }

    //         const labelContent = await fs.promises.readFile(labelPath, 'utf-8');
    //         const labels = labelContent
    //             .split('\n')
    //             .filter(line => line.trim())
    //             .map(line => {
    //                 const parts = line.split(' ');
    //                 console.log(`parts: ${parts[0]}, ${parts[1]}, ${parts[2]}, ${parts[3]}, ${parts[4]}`);
    //                 return {
    //                     classId: parseInt(parts[0]),
    //                     cx: parseFloat(parts[1]),
    //                     cy: parseFloat(parts[2]),
    //                     w: parseFloat(parts[3]),
    //                     h: parseFloat(parts[4])
    //                 };
    //             });

    //         // Cache the result
    //         const mtime = await this.getFileModTime(labelPath);
    //         this.labelCache.set(cacheKey, { labels, mtime });

    //         console.log(`loadLabelsForImage: found labels: ${labels}`);

    //         return labels;
    //     } catch (error) {
    //         return [];
    //     }
    // }

    // private async getFileModTime(filePath: string): Promise<number> {
    //     try {
    //         const stats = await fs.promises.stat(filePath);
    //         return stats.mtime.getTime();
    //     } catch {
    //         return 0;
    //     }
    // }

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
        const labelsDir = dir.replace(`${path.sep}images${path.sep}`, `${path.sep}labels${path.sep}`);
        return path.join(labelsDir, `${name}.txt`);
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
    constructor(public readonly uri: vscode.Uri) { }

    dispose(): void {
        // Cleanup if needed
    }
}
