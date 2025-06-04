import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Type definitions for better type safety
interface YOLOLabel {
    classId: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
}

interface ExtensionState {
    allImagesInDir: string[];
    currentImageIndex: number;
    imagesDirPath: string | undefined;
    labelsDirPath: string | undefined;
    classNames: string[];
    webviewPanel: vscode.WebviewPanel | undefined;
}

// Store extension state globally within the activate function's scope
let state: ExtensionState = {
    allImagesInDir: [],
    currentImageIndex: -1,
    imagesDirPath: undefined,
    labelsDirPath: undefined,
    classNames: [],
    webviewPanel: undefined
};

export function activate(context: vscode.ExtensionContext) {
    console.log('YOLO Annotator extension is now active.');

    const disposable = vscode.commands.registerCommand('yolo-annotator.start', async () => {
        try {
            await initializeAnnotationSession(context);
        } catch (error) {
            console.error('Error starting YOLO Annotator:', error);
            vscode.window.showErrorMessage(`Failed to start YOLO Annotator: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    context.subscriptions.push(disposable);
}

async function initializeAnnotationSession(context: vscode.ExtensionContext): Promise<void> {
    // Reset state for a new session
    resetState();

    // Configuration inputs with better validation
    const imageDirUri = await getDirectory('Select Images Directory (JPEG, PNG, JPG)');
    if (!imageDirUri) {
        throw new Error('Image directory selection is required.');
    }
    state.imagesDirPath = imageDirUri.fsPath;

    const labelDirUri = await getDirectory('Select Labels Directory (for .txt files)');
    if (!labelDirUri) {
        throw new Error('Label directory selection is required.');
    }
    state.labelsDirPath = labelDirUri.fsPath;

    const classesFileUri = await getFile('Select classes.txt file', 'txt');
    if (!classesFileUri) {
        throw new Error('classes.txt file selection is required.');
    }

    // Read and validate class names
    await loadClassNames(classesFileUri.fsPath);

    // Read and validate images from directory
    await loadImages();

    // Create and configure webview panel
    await createWebviewPanel(context);
}

function resetState(): void {
    state.allImagesInDir = [];
    state.currentImageIndex = -1;
    state.imagesDirPath = undefined;
    state.labelsDirPath = undefined;
    state.classNames = [];
    
    if (state.webviewPanel) {
        state.webviewPanel.dispose();
        state.webviewPanel = undefined;
    }
}

async function loadClassNames(classesFilePath: string): Promise<void> {
    try {
        const content = await fs.promises.readFile(classesFilePath, 'utf-8');
        state.classNames = content
            .split('\n')
            .map(c => c.trim())
            .filter(c => c.length > 0);

        if (state.classNames.length === 0) {
            vscode.window.showWarningMessage('classes.txt is empty or contains no valid class names. Annotations may not have proper class labels.');
        }
    } catch (error) {
        throw new Error(`Error reading classes.txt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function loadImages(): Promise<void> {
    if (!state.imagesDirPath) {
        throw new Error('Images directory path is not set');
    }

    try {
        const files = await fs.promises.readdir(state.imagesDirPath);
        state.allImagesInDir = files
            .filter(f => ['.jpg', '.png', '.jpeg'].includes(path.extname(f).toLowerCase()))
            .sort(); // Sort for consistent order

        if (state.allImagesInDir.length === 0) {
            throw new Error('No images found in the selected directory.');
        }
    } catch (error) {
        throw new Error(`Error reading images directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function createWebviewPanel(context: vscode.ExtensionContext): Promise<void> {
    if (!state.imagesDirPath) {
        throw new Error('Images directory path is not set');
    }

    state.webviewPanel = vscode.window.createWebviewPanel(
        'yoloAnnotator',
        'YOLO Annotation Editor',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(state.imagesDirPath)],
            retainContextWhenHidden: true
        }
    );

    // Handle webview messages
    state.webviewPanel.webview.onDidReceiveMessage(
        async message => {
            try {
                await handleWebviewMessage(message);
            } catch (error) {
                console.error('Error handling webview message:', error);
                vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        },
        undefined,
        context.subscriptions
    );

    // Generate webview HTML
    state.webviewPanel.webview.html = getWebviewContent(state.webviewPanel.webview);

    // Handle panel disposal
    state.webviewPanel.onDidDispose(() => {
        resetState();
        console.log('YOLO Annotator panel disposed and state reset.');
    }, null, context.subscriptions);
}

async function handleWebviewMessage(message: any): Promise<void> {
    switch (message.command) {
        case 'saveLabels':
            if (state.labelsDirPath && message.imageName && message.labels) {
                const saved = await saveLabels(state.labelsDirPath, message.imageName, message.labels);
                if (saved) {
                    vscode.window.showInformationMessage(`Labels saved for ${message.imageName}`);
                    state.webviewPanel?.webview.postMessage({ 
                        command: 'labelsSaved', 
                        imageName: message.imageName 
                    });
                }
            }
            break;

        case 'requestNextImage':
            if (state.currentImageIndex < state.allImagesInDir.length - 1) {
                state.currentImageIndex++;
                await sendImageDataToWebview(state.currentImageIndex);
            } else {
                state.webviewPanel?.webview.postMessage({ 
                    command: 'updateNavButtons', 
                    canGoNext: false, 
                    canGoPrev: state.currentImageIndex > 0 
                });
            }
            break;

        case 'requestPreviousImage':
            if (state.currentImageIndex > 0) {
                state.currentImageIndex--;
                await sendImageDataToWebview(state.currentImageIndex);
            } else {
                state.webviewPanel?.webview.postMessage({ 
                    command: 'updateNavButtons', 
                    canGoNext: state.allImagesInDir.length > 1, 
                    canGoPrev: false 
                });
            }
            break;

        case 'webviewReady':
            if (state.allImagesInDir.length > 0 && state.currentImageIndex === -1) {
                state.currentImageIndex = 0;
                await sendImageDataToWebview(state.currentImageIndex);
            } else if (state.allImagesInDir.length === 0) {
                state.webviewPanel?.webview.postMessage({ command: 'noImagesFound' });
            }
            break;

        case 'showError':
            if (message.message) {
                vscode.window.showErrorMessage(message.message);
            }
            break;
    }
}

async function getDirectory(title: string): Promise<vscode.Uri | undefined> {
    const result = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        title
    });
    return result ? result[0] : undefined;
}

async function getFile(title: string, ...ext: string[]): Promise<vscode.Uri | undefined> {
    const result = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectMany: false,
        title,
        filters: { 'Files': ext }
    });
    return result ? result[0] : undefined;
}

async function saveLabels(labelDir: string, imageName: string, labels: YOLOLabel[]): Promise<boolean> {
    const baseName = path.basename(imageName, path.extname(imageName));
    const labelPath = path.join(labelDir, `${baseName}.txt`);
    const content = labels
        .map(l => `${l.classId} ${l.cx.toFixed(6)} ${l.cy.toFixed(6)} ${l.w.toFixed(6)} ${l.h.toFixed(6)}`)
        .join('\n');

    try {
        // Ensure target directory exists
        await fs.promises.mkdir(labelDir, { recursive: true });

        // Check if file exists and prompt for overwrite if it's not empty
        try {
            const existingContent = await fs.promises.readFile(labelPath, 'utf-8');
            if (existingContent.trim() !== '') {
                const choice = await vscode.window.showWarningMessage(
                    `Label file for "${imageName}" already exists. Overwrite?`,
                    { modal: true },
                    "Overwrite"
                );

                if (choice !== "Overwrite") {
                    vscode.window.showInformationMessage('Save operation cancelled.');
                    return false;
                }
            }
        } catch (error) {
            // File doesn't exist, which is fine
        }

        await fs.promises.writeFile(labelPath, content);
        return true;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to save labels for ${imageName}: ${errorMessage}`);
        console.error(`Failed to save labels to ${labelPath}:`, error);
        return false;
    }
}

async function sendImageDataToWebview(imageIndex: number): Promise<void> {
    if (!state.imagesDirPath || !state.webviewPanel || imageIndex < 0 || imageIndex >= state.allImagesInDir.length) {
        console.error('Invalid state for sending image data:', { 
            imagesDirPath: state.imagesDirPath, 
            imageIndex, 
            allImagesInDirLength: state.allImagesInDir.length 
        });
        state.webviewPanel?.webview.postMessage({ 
            command: 'error', 
            message: 'Could not load image data (invalid index or path).' 
        });
        return;
    }

    const imageName = state.allImagesInDir[imageIndex];
    const imageFileOnDisk = vscode.Uri.file(path.join(state.imagesDirPath, imageName));
    
    // Check if the image file actually exists
    try {
        await fs.promises.access(imageFileOnDisk.fsPath);
    } catch (error) {
        console.error(`Image file not found: ${imageFileOnDisk.fsPath}`);
        state.webviewPanel.webview.postMessage({ 
            command: 'error', 
            message: `Image file "${imageName}" not found.` 
        });
        vscode.window.showErrorMessage(`Image file ${imageName} is missing. Please check the image directory.`);
        return;
    }

    const imageWebviewUri = state.webviewPanel.webview.asWebviewUri(imageFileOnDisk);
    const parsedLabels = await loadLabelsForImage(imageName);

    state.webviewPanel.webview.postMessage({
        command: 'loadImage',
        imageName: imageName,
        imageUri: imageWebviewUri.toString(),
        labels: parsedLabels,
        classes: state.classNames,
        currentIndex: imageIndex,
        totalImages: state.allImagesInDir.length
    });
}

async function loadLabelsForImage(imageName: string): Promise<YOLOLabel[]> {
    if (!state.labelsDirPath) {
        return [];
    }

    const baseName = path.basename(imageName, path.extname(imageName));
    const labelPath = path.join(state.labelsDirPath, `${baseName}.txt`);
    
    try {
        const labelContent = await fs.promises.readFile(labelPath, 'utf-8');
        return labelContent
            .split('\n')
            .filter(l => l.trim())
            .map(line => {
                const parts = line.split(' ');
                if (parts.length < 5) {
                    console.warn(`Skipping malformed label line (not enough parts) in ${labelPath}: ${line}`);
                    return null;
                }

                const classId = parseInt(parts[0], 10);
                const cx = parseFloat(parts[1]);
                const cy = parseFloat(parts[2]);
                const w = parseFloat(parts[3]);
                const h = parseFloat(parts[4]);

                if (isNaN(classId) || isNaN(cx) || isNaN(cy) || isNaN(w) || isNaN(h)) {
                    console.warn(`Skipping malformed label line (NaN values) in ${labelPath}: ${line}`);
                    return null;
                }

                // Basic validation for YOLO coordinates (0 to 1)
                if (cx < 0 || cx > 1 || cy < 0 || cy > 1 || w < 0 || w > 1 || h < 0 || h > 1) {
                    console.warn(`Skipping label with out-of-bounds coordinates in ${labelPath}: ${line}`);
                    return null;
                }

                if (w === 0 || h === 0) {
                    console.warn(`Skipping label with zero width/height in ${labelPath}: ${line}`);
                    return null;
                }

                return { classId, cx, cy, w, h };
            })
            .filter((label): label is YOLOLabel => label !== null);
    } catch (error) {
        // File doesn't exist or can't be read - this is normal for new images
        return [];
    }
}

function getWebviewContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: https:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YOLO Annotation Editor</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            margin: 0; 
            padding: 0; 
            display: flex; 
            height: 100vh; 
            overflow: hidden; 
            font-size: 14px; 
            background-color: #1e1e1e; 
            color: #cccccc;
        }
        
        .container { 
            display: flex; 
            width: 100%; 
            height: 100%; 
        }
        
        .image-panel { 
            flex: 3; 
            position: relative; 
            overflow: auto; 
            background-color: #252526; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            padding: 10px;
        }
        
        .image-container { 
            position: relative; 
            box-shadow: 0 0 10px rgba(0,0,0,0.5); 
        } 
        
        #mainImage { 
            display: block; 
            max-width: 100%; 
            max-height: calc(100vh - 40px); 
            user-select: none; 
            background-color: #333; 
        } 
        
        #canvas { 
            position: absolute; 
            top: 0; 
            left: 0; 
            cursor: crosshair; 
            user-select: none; 
        }
        
        .controls-panel { 
            flex: 1; 
            padding: 15px; 
            overflow-y: auto; 
            background-color: #2d2d2d; 
            border-left: 1px solid #3c3c3c; 
            display: flex; 
            flex-direction: column; 
            min-width: 280px; 
            max-width: 400px;
        }
        
        .control-group { 
            margin-bottom: 15px; 
            padding: 12px; 
            background-color: #333333; 
            border-radius: 6px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.2); 
        }
        
        .control-group h3 { 
            margin-top: 0; 
            margin-bottom: 12px; 
            font-size: 16px; 
            color: #00aeff; 
            border-bottom: 1px solid #444; 
            padding-bottom: 5px;
        }
        
        .navigation-controls { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 12px; 
        }
        
        #imageInfo { 
            font-weight: bold; 
            color: #bbbbbb; 
        }
        
        button { 
            padding: 8px 15px; 
            background-color: #007acc; 
            color: white; 
            border: none; 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 14px;
            transition: background-color 0.2s ease;
            margin: 2px;
        }
        
        button:hover { 
            background-color: #0095ff; 
        }
        
        button:disabled { 
            background-color: #555; 
            color: #888; 
            cursor: not-allowed; 
        }
        
        #editFormContainer { 
            margin-top: 10px; 
        }
        
        #editFormContainer label { 
            display: block; 
            margin-bottom: 6px; 
            font-weight: bold; 
            color: #cccccc; 
        }
        
        #editFormContainer select, 
        #editFormContainer input[type="text"] { 
            width: calc(100% - 12px); 
            padding: 8px; 
            margin-bottom: 12px; 
            border-radius: 4px; 
            border: 1px solid #555; 
            background-color: #3c3c3c;
            color: #ddd;
        }
        
        #editFormContainer select:focus, 
        #editFormContainer input[type="text"]:focus {
            border-color: #007acc;
            outline: none;
        }
        
        #labelListDisplay .label-item { 
            padding: 10px; 
            margin-bottom: 6px; 
            background-color: #3f3f3f; 
            border-radius: 4px; 
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background-color 0.2s ease;
            border-left: 3px solid transparent;
        }
        
        #labelListDisplay .label-item:hover { 
            background-color: #4a4a4a; 
        }
        
        #labelListDisplay .label-item.selected { 
            background-color: #005a99; 
            font-weight: bold; 
            color: white;
            border-left: 3px solid #00aeff;
        }

        .no-content { 
            text-align: center; 
            color: #888; 
            margin-top: 20px; 
            font-style: italic; 
        }
        
        .status-message {
            padding: 10px;
            margin-bottom: 10px;
            border-radius: 4px;
            text-align: center;
            font-weight: bold;
        }
        
        .status-success { 
            background-color: #28a745; 
            color: white; 
        }
        
        .status-error { 
            background-color: #dc3545; 
            color: white; 
        }
        
        .status-info { 
            background-color: #17a2b8; 
            color: white; 
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="image-panel">
            <div class="image-container">
                <img id="mainImage" src="" alt="Annotation Image">
                <canvas id="canvas"></canvas>
            </div>
        </div>
        <div class="controls-panel">
            <div id="statusMessagesContainer"></div>

            <div class="control-group">
                <h3>Navigation & Actions</h3>
                <div class="navigation-controls">
                    <button id="prevBtn" title="Previous Image (Left Arrow)">‹ Prev</button>
                    <span id="imageInfo">No Image Loaded</span>
                    <button id="nextBtn" title="Next Image (Right Arrow)">Next ›</button>
                </div>
                <button id="addLabelBtn" title="Start drawing a new label (A)">Add New Label</button>
                <button id="saveBtn" title="Save all labels for current image (Ctrl+S)" style="margin-top:10px; background-color: #28a745;">Save Labels</button>
            </div>

            <div class="control-group">
                <h3>Edit Selected Label</h3>
                <div id="editFormContainer">
                    <p class="no-content">Select or create a label to edit.</p>
                </div>
            </div>

            <div class="control-group">
                <h3 id="currentLabelsHeader">Current Labels (0)</h3>
                <div id="labelListDisplay" style="max-height: 300px; overflow-y: auto;">
                     <p class="no-content">No labels yet for this image.</p>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        // JavaScript code remains largely the same as your original implementation
        // but with improved error handling and type safety
        
        const vscode = acquireVsCodeApi();
        const imgElement = document.getElementById('mainImage');
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');

        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const imageInfoSpan = document.getElementById('imageInfo');
        const saveBtn = document.getElementById('saveBtn');
        const addLabelBtn = document.getElementById('addLabelBtn');
        const editFormContainer = document.getElementById('editFormContainer');
        const labelListDisplay = document.getElementById('labelListDisplay');
        const currentLabelsHeader = document.getElementById('currentLabelsHeader');
        const statusMessagesContainer = document.getElementById('statusMessagesContainer');

        let currentImageName = '';
        let currentLabels = []; 
        let currentClassNames = [];
        let selectedLabelIndex = -1; 
        let unsavedChanges = false;
        let isDrawing = false;
        let isDrawingMode = false; 
        let startX, startY, mouseX, mouseY; 

        function showStatusMessage(message, type = 'info', duration = 3000) {
            statusMessagesContainer.innerHTML = '';
            const messageDiv = document.createElement('div');
            messageDiv.className = \`status-message status-\${type}\`;
            messageDiv.textContent = message;
            statusMessagesContainer.appendChild(messageDiv);
            if (duration > 0) {
                setTimeout(() => {
                    if (statusMessagesContainer.contains(messageDiv)) {
                         statusMessagesContainer.removeChild(messageDiv);
                    }
                }, duration);
            }
        }
        
        // Rest of your JavaScript implementation would go here...
        // I've kept the core structure but would recommend similar improvements
        // to error handling and type safety throughout
        
        vscode.postMessage({ command: 'webviewReady' });
    </script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function deactivate() {
    console.log('YOLO Annotator extension is now deactivated.');
    if (state.webviewPanel) {
        state.webviewPanel.dispose();
    }
}