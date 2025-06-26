import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import * as preloader from './preloader';
import { SettingsManager } from './settings_manager';

// Custom Editor Provider for Image Annotation
export class YOLOImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
    private imagePreloader?: preloader.ImagePreloader;
    private classesPath = '';
    private classes = new Array<string>();
    private stopWorking = false;
    private classColors: string[] = [];

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
            SettingsManager.getPreviousImagesToPreload(), // previous
            SettingsManager.getNextImagesToPreload(),  // next
            SettingsManager.getKeepBufferSize()
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
                    console.error("Can't find classes.txt");
                    vscode.window.showErrorMessage("Failed to load the classes.txt file. Please put it in the parent directory or images/labels folder.");
                    return;
                } else {
                    this.classesPath = this.classesPath.replace('classes.txt', 'labels' + path.sep + 'classes.txt');
                }
            }
        }
        try {
            this.classes = fs.readFileSync(this.classesPath, 'utf8').split('\n').filter(line => line.trim());
            this.classColors = new Colors().getColors(this.classes.length);
        } catch (error) {
            console.error("Can't find classes.txt");
            vscode.window.showErrorMessage("Failed to load the classes.txt file. Please put it in the parent directory or images/labels folder.");
        }
    }

    private getOverlayHTML(webview: vscode.Webview, extensionPath: string, imageUri: vscode.Uri): string {
        const nonce = this.getNonce();
        const imageWebviewUri = webview.asWebviewUri(imageUri);
        const showShortcutsHelp = SettingsManager.getShowShortcutsHelp();

        try {
            // Path to your HTML file
            const htmlPath = vscode.Uri.file(path.join(extensionPath, 'media', 'html', 'overlay.html'));
            let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

            // Replace placeholders in the HTML content
            htmlContent = htmlContent.replace(/\$\{nonce\}/g, nonce);
            // htmlContent = htmlContent.replace(/\$\{imageWebviewUri\}/g, imageWebviewUri.toString());
            htmlContent = htmlContent.replace(/\$\{showShortcutsHelp\}/g, showShortcutsHelp ? 'show' : 'hide');
            htmlContent = htmlContent.replace(/\$\{webview.cspSource\}/g, webview.cspSource);

            return htmlContent;
        } catch (error) {
            console.error("Error reading HTML file:", error);
            vscode.window.showErrorMessage("Failed to load the annotation editor. Please check the extension logs for details.");
        }

        return "<h1>Error loading editor</h1>";
    }

    private async showClassInputPrompt(webview: vscode.Webview, labelIndex: number, prevClassIndex: number) {
        if (!this.classes || this.classes.length === 0) {
            vscode.window.showErrorMessage("Class list is empty or not loaded.");
            return;
        }

        var quickPickItems: vscode.QuickPickItem[] = [];
        if (prevClassIndex === -1) {
            quickPickItems = this.classes
                .map(className => ({
                    label: className,
                    description: undefined
                }));
        } else {
            const currentClass = this.classes[prevClassIndex];
            quickPickItems = [
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
        }

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
                    className: selectedClass.label
                });
            } else {
                console.warn("No active webview panel to post message.");
            }
        } else {
            console.log("User cancelled class selection prompt.");
        }
    }

    private async showDiscardChangesChoice(): Promise<'save' | 'discard' | ''> {
        const result = await vscode.window.showInformationMessage(
            'You have unsaved changes. What would you like to do?',
            { modal: true }, // Makes it modal (blocking)
            'Save',
            'Discard'
        );
        switch (result) {
            case 'Save':
                return 'save';
            case 'Discard':
                return 'discard';
            default:
                return '';
        }
    }

    private async sendCacheBuffer(webview: vscode.Webview, currentKeys: number[]): Promise<void> {
        const buffer = await this.imagePreloader?.getImageAndLabelBatchAroundCurrent(currentKeys);

        if (buffer) {

            for (const batchElem of buffer.batch.values()) {
                if (this.stopWorking) { return; }
                webview.postMessage({
                    command: 'updateImageAndLabelBuffer',
                    batchElement: batchElem,
                    classes: this.classes,
                    classColors: this.classColors
                });
            }
        }
        webview.postMessage({
            command: 'updateImageAndLabelBufferEnd'
        });
    }

    private async reloadWithDifferentDocument(webviewPanel: vscode.WebviewPanel, newDocumentPath: string): Promise<void> {
        try {
            // Get the new document URI
            const newUri = vscode.Uri.file(newDocumentPath);

            // Check if the file exists
            if (!fs.existsSync(newDocumentPath)) {
                vscode.window.showErrorMessage(`File not found: ${newDocumentPath}`);
                return;
            }
            this.stopWorking = true; // Stop any ongoing operations
            // Close the current editor panel
            webviewPanel.dispose();

            // Open the new document with the same custom editor
            await vscode.commands.executeCommand('vscode.openWith', newUri, 'yolo-annotator.imageEditor');

        } catch (error) {
            console.error('Failed to reload with different document:', error);
            vscode.window.showErrorMessage(`Failed to reload editor: ${error}`);
        }
    }

    private async setupMessageHandling(webviewPanel: vscode.WebviewPanel, document: YOLOImageDocument): Promise<void> {
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'giveMeSettings':
                    webviewPanel.webview.postMessage({
                        command: 'takeTheseSettings',
                        settings: SettingsManager.getAllSettings()
                    });
                    break;
                case 'loadLabels':
                    this.imagePreloader?.setCurrentIndex(message.currentImageIndex);
                    const labels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'labelsLoaded',
                        labels: labels,
                        classes: this.classes,
                        classColors: this.classColors
                    });
                    break;

                case 'saveLabels':
                    const result = await this.imagePreloader?.saveLabelsForImage(message.imageFilename, message.newLabels) || false;
                    webviewPanel.webview.postMessage({
                        command: 'afterSave',
                        result: result
                    });
                    break;

                case 'getCurrentImage':
                    const currentSrc = this.imagePreloader?.getCurrentImageSource();
                    const currentInfo = this.imagePreloader?.getCurrentImageInfo();
                    const currentLabels = await this.imagePreloader?.getCurrentLabel();
                    webviewPanel.webview.postMessage({
                        command: 'updateImage',
                        src: currentSrc,
                        info: currentInfo,
                        labels: currentLabels,
                        classes: this.classes,
                        classColors: this.classColors
                    });
                    break;

                case 'prevImage':
                    this.imagePreloader?.setCurrentIndex(message.currentImageIndex);
                    const prevHTML = await this.imagePreloader?.goToPrevious(); // this updates the preload cache
                    await this.sendCacheBuffer(webviewPanel.webview, message.currentKeys); // send the recent cache
                    break;

                case 'nextImage':
                    this.imagePreloader?.setCurrentIndex(message.currentImageIndex);
                    const nextHTML = await this.imagePreloader?.goToNext(); // this updates the preload cache
                    await this.sendCacheBuffer(webviewPanel.webview, message.currentKeys); // send the recent cache
                    break;

                case 'gotoImage':
                    const gotoHTML = await this.imagePreloader?.goToIndex(message.index); // this updates the preload cache
                    await this.sendCacheBuffer(webviewPanel.webview, message.currentKeys); // send the recent cache
                    break;

                case 'sendCacheBuffer':
                    await this.sendCacheBuffer(webviewPanel.webview, message.currentKeys);
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

                case 'showDiscardChangesChoice':
                    const discardResult = await this.showDiscardChangesChoice();
                    webviewPanel.webview.postMessage({
                        command: 'discardChangesChoiceResult',
                        result: discardResult
                    });
                    break;

                case 'reloadWindow':
                    this.imagePreloader?.setCurrentIndex(message.currentImageIndex);
                    await this.reloadWithDifferentDocument(webviewPanel, this.imagePreloader?.getCurrentImagePath() || document.uri.fsPath);
                    break;
            }
        });
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


class Colors {
    private colorPallete = [
        "rgba(0, 128, 255, 1)",
        "rgba(123, 44, 191, 1)",
        "rgba(115, 210, 222, 1)",
        "rgba(60, 39, 108, 1)",
        "rgba(17, 230, 216, 1)",
        "rgba(33, 131, 128, 1)",
        "rgba(90, 24, 144, 1)",
        "rgba(61, 110, 118, 1)",
        "rgba(74, 171, 175, 1)",
        "rgba(25, 37, 173, 1)",
        "rgba(157, 78, 221, 1)",
        "rgba(88, 88, 107, 1)",
        "rgba(26, 75, 102, 1)",
        "rgba(51, 102, 131, 1)",
        "rgba(102, 155, 188, 1)",
        "rgba(255, 109, 0, 1)",
        "rgba(255, 133, 0, 1)",
        "rgba(255, 145, 0, 1)",
        "rgba(255, 158, 0, 1)",
        "rgba(119, 76, 96, 1)",
        "rgba(135, 81, 99, 1)",
        "rgba(151, 85, 101, 1)",
        "rgba(183, 93, 105, 1)",
        "rgba(209, 149, 150, 1)",
        "rgba(234, 205, 194, 1)",
        "rgba(255, 188, 66, 1)",
        "rgba(236, 103, 78, 1)",
        "rgba(126, 17, 209, 1)",
        "rgba(0, 48, 133, 1)",
        "rgba(110, 131, 88, 1)",
        "rgba(143, 45, 86, 1)",
        "rgba(60, 111, 65, 1)",
        "rgba(67, 100, 65, 1)",
        "rgba(83, 18, 83, 1)",
        "rgba(93, 38, 95, 1)",
        "rgba(103, 57, 106, 1)",
        "rgba(122, 95, 128, 1)",
        "rgba(120, 0, 0, 1)",
        "rgba(153, 161, 131, 1)",
        "rgba(223, 129, 122, 1)",
    ];
    constructor() {
        // this.shuffleColors();
    }

    public getColors(num_colors: number): string[] {
        if (num_colors > this.colorPallete.length) {
            let times = Math.ceil(num_colors / this.colorPallete.length);
            let color_array: string[] = [];
            while (times--) {
                color_array = color_array.concat(this.colorPallete);
                this.shuffleColors();
            }
            return color_array.slice(0, num_colors);
        }
        return this.colorPallete.slice(0, num_colors);
    }

    private shuffleColors() {
        for (var i = this.colorPallete.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = this.colorPallete[i];
            this.colorPallete[i] = this.colorPallete[j];
            this.colorPallete[j] = temp;
        }
    }
}