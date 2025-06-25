import * as vscode from 'vscode';

/**
 * Helper class to manage extension settings
 */
export class SettingsManager {
    private static readonly EXTENSION_NAME = 'yoloAnnotator';

    /**
     * Get a configuration value with type safety
     */
    private static getConfig<T>(key: string, defaultValue: T): T {
        const config = vscode.workspace.getConfiguration(this.EXTENSION_NAME);
        return config.get<T>(key, defaultValue);
    }

    /**
     * Set a configuration value
     */
    private static async setConfig<T>(key: string, value: T, target?: vscode.ConfigurationTarget): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.EXTENSION_NAME);
        await config.update(key, value, target || vscode.ConfigurationTarget.Workspace);
    }

    // Preload Settings
    static getNextImagesToPreload(): number {
        return this.getConfig('preload.nextImages', 3);
    }

    static getPreviousImagesToPreload(): number {
        return this.getConfig('preload.previousImages', 2);
    }

    static getKeepBufferSize(): number {
        return this.getConfig('preload.keepBuffer', 5);
    }

    static async setPreloadSettings(next: number, previous: number, buffer: number): Promise<void> {
        await this.setConfig('preload.nextImages', next);
        await this.setConfig('preload.previousImages', previous);
        await this.setConfig('preload.keepBuffer', buffer);
    }

    // UI Settings
    static getShowShortcutsHelp(): boolean {
        return this.getConfig('ui.showShortcutsHelp', true);
    }

    static getFontSize(): number {
        return this.getConfig('ui.fontSize', 16);
    }
    /**
     * Get all settings as an object
     */
    static getAllSettings() {
        return {
            preload: {
                nextImages: this.getNextImagesToPreload(),
                previousImages: this.getPreviousImagesToPreload(),
                keepBuffer: this.getKeepBufferSize()
            },
            ui: {
                showShortcutsHelp: this.getShowShortcutsHelp(),
                fontSize: this.getFontSize()
            }
        };
    }

    /**
     * Listen for configuration changes
     */
    static onConfigurationChanged(callback: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(this.EXTENSION_NAME)) {
                callback(e);
            }
        });
    }

    /**
     * Check if a specific setting has changed
     */
    static hasSettingChanged(e: vscode.ConfigurationChangeEvent, settingKey: string): boolean {
        return e.affectsConfiguration(`${this.EXTENSION_NAME}.${settingKey}`);
    }
}