import * as vscode from 'vscode';
import { YOLOImageEditorProvider } from './yolo_image_editor';

export function activate(context: vscode.ExtensionContext) {
    console.log('YOLO Annotator extension is now active.');

    // Register the custom editor
    const customEditorProvider = YOLOImageEditorProvider.register(context);
    context.subscriptions.push(customEditorProvider);

    // Register the "Open with YOLO Annotator" command
    const openWithAnnotatorCommand = vscode.commands.registerCommand(
        'yolo-annotator.openWithAnnotator',
        async (uri?: vscode.Uri) => {
            // Get the URI of the file to open
            let fileUri = uri;
            
            if (!fileUri) {
                // If no URI provided, try to get from active editor
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    console.log('No URI provided, using active editor document:', activeEditor.document.uri);
                    fileUri = activeEditor.document.uri;
                } else {
                    // Show file picker
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            'Images': ['jpg', 'jpeg', 'png', 'JPG', 'JPEG', 'PNG']
                        },
                        title: 'Select Image to Annotate'
                    });
                    
                    if (result && result[0]) {
                        fileUri = result[0];
                    } else {
                        vscode.window.showWarningMessage('No image file selected.');
                        return;
                    }
                }
            }

            // Validate file extension
            const allowedExtensions = ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG'];
            const fileExtension = fileUri.fsPath.toLowerCase().substring(fileUri.fsPath.lastIndexOf('.'));
            
            if (!allowedExtensions.includes(fileExtension)) {
                vscode.window.showErrorMessage('Please select a valid image file (JPG, JPEG, PNG).');
                return;
            }

            try {
                // Open the file with our custom editor
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    fileUri,
                    'yolo-annotator.imageEditor'
                );
            } catch (error) {
                console.error('Error opening with YOLO Annotator:', error);
                vscode.window.showErrorMessage(`Failed to open with YOLO Annotator: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    );

    // Register the legacy "start" command for backward compatibility
    const startCommand = vscode.commands.registerCommand(
        'yolo-annotator.start',
        async () => {
            // Show file picker and open with annotator
            await vscode.commands.executeCommand('yolo-annotator.openWithAnnotator');
        }
    );

    // Register command to set as default editor for images
    const setAsDefaultCommand = vscode.commands.registerCommand(
        'yolo-annotator.setAsDefault',
        async () => {
            const config = vscode.workspace.getConfiguration();
            const workbenchConfig = config.get('workbench.editorAssociations') as any || {};
            
            // Set YOLO Annotator as default for image files
            workbenchConfig['*.jpg'] = 'yolo-annotator.imageEditor';
            workbenchConfig['*.jpeg'] = 'yolo-annotator.imageEditor';
            workbenchConfig['*.png'] = 'yolo-annotator.imageEditor';
            workbenchConfig['*.JPG'] = 'yolo-annotator.imageEditor';
            workbenchConfig['*.JPEG'] = 'yolo-annotator.imageEditor';
            workbenchConfig['*.PNG'] = 'yolo-annotator.imageEditor';
            
            await config.update('workbench.editorAssociations', workbenchConfig, vscode.ConfigurationTarget.Global);
            
            vscode.window.showInformationMessage('YOLO Annotator is now the default editor for image files.');
        }
    );

    context.subscriptions.push(
        openWithAnnotatorCommand,
        startCommand,
        setAsDefaultCommand
    );

    // Show getting started message
    // Show getting started message only if no YOLO editor is already open
    const isYOLOEditorOpen = vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .some(tab => tab.input && 
              typeof tab.input === 'object' &&
              tab.input !== null &&
              'viewType' in tab.input && 
              (tab.input as any).viewType === 'yolo-annotator.imageEditor');

    if (!isYOLOEditorOpen) {
        vscode.window.showInformationMessage(
            'YOLO Annotator activated! Right-click on an image file to "Open with YOLO Annotator"',
            'Open Image',
            'Set as Default'
        ).then(selection => {
            switch (selection) {
                case 'Open Image':
                    vscode.commands.executeCommand('yolo-annotator.openWithAnnotator');
                    break;
                case 'Set as Default':
                    vscode.commands.executeCommand('yolo-annotator.setAsDefault');
                    break;
            }
        });
    }
}

export function deactivate() {
    console.log('YOLO Annotator extension is now deactivated.');
}