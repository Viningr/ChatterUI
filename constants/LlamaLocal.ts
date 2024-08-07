import * as FS from 'expo-file-system'
import { CompletionParams, LlamaContext, initLlama } from 'llama.rn'
import { Platform } from 'react-native'
import DocumentPicker from 'react-native-document-picker'
import { create } from 'zustand'

import { AppSettings, Global } from './GlobalValues'
import { Logger } from './Logger'
import { mmkv } from './mmkv'

type CompletionTimings = {
    predicted_per_token_ms: number
    predicted_per_second: number | null
    predicted_ms: number
    predicted_n: number

    prompt_per_token_ms: number
    prompt_per_second: number | null
    prompt_ms: number
    prompt_n: number
}

type CompletionOutput = {
    text: string
    timings: CompletionTimings
}

type LlamaState = {
    context: LlamaContext | undefined
    modelname: string | undefined
    load: (name: string, preset?: LlamaPreset, usecache?: boolean) => Promise<void>
    unload: () => Promise<void>
    saveKV: () => Promise<void>
    loadKV: () => Promise<void>
    completion: (
        params: CompletionParams,
        callback: (text: string) => void,
        completed: (text: string) => void
    ) => Promise<void>
    stopCompletion: () => Promise<void>
    tokenLength: (text: string) => Promise<number>
}

export type LlamaPreset = {
    context_length: number
    threads: number
    gpu_layers: number
    batch: number
}

const sessionFileDir = `${FS.documentDirectory}llama/`
const sessionFile = `${sessionFileDir}llama-session.bin`

const default_preset = {
    context_length: 2048,
    threads: 1,
    gpu_layers: 0,
    batch: 512,
}

export namespace Llama {
    const model_dir = `${FS.documentDirectory}models/`

    export const useLlama = create<LlamaState>()((set, get) => ({
        context: undefined,
        modelname: undefined,
        load: async (
            name: string,
            preset: LlamaPreset = default_preset,
            usecache: boolean = true
        ) => {
            const dir = `${model_dir}${name}`

            switch (name) {
                case '':
                    return Logger.log('No Model Chosen', true)
                case get().modelname:
                    return Logger.log('Model Already Loaded!', true)
            }

            if (!(await modelExists(name))) {
                Logger.log('Model Does Not Exist!', true)
                return
            }

            if (get().context !== undefined) {
                Logger.log('Unloading current model', true)
                await get().context?.release()
                set((state) => ({ ...state, context: undefined, modelname: undefined }))
            }

            const params = {
                model: dir,
                n_ctx: preset.context_length,
                n_threads: preset.threads,
                n_batch: preset.batch,
                n_gpu_layers: Platform.OS === 'ios' ? preset.gpu_layers : 0,
            }

            mmkv.set(Global.LocalSessionLoaded, false)
            Logger.log(`Loading Model: ${name}`, true)
            Logger.log(JSON.stringify(params))

            const llamaContext = await initLlama(params).catch((error) => {
                Logger.log(`Could Not Load Model: ${error} `, true)
            })

            if (llamaContext) {
                set((state) => ({ ...state, context: llamaContext, modelname: name }))
                Logger.log('Model Loaded', true)
            }
        },
        unload: async () => {
            get().context?.release()
        },
        completion: async (
            params: CompletionParams,
            callback = (text: string) => {},
            completed = (text: string) => {}
        ) => {
            const llamaContext = get().context
            if (llamaContext === undefined) {
                Logger.log('No Model Loaded', true)
                return
            }

            return llamaContext
                .completion(params, (data: any) => {
                    callback(data.token)
                })
                .then(async ({ text, timings }: CompletionOutput) => {
                    completed(text)
                    Logger.log(textTimings(timings))
                    if (mmkv.getBoolean(AppSettings.SaveLocalKV)) {
                        await get().saveKV()
                    }
                })
        },
        stopCompletion: async () => {
            await get().context?.stopCompletion()
        },
        saveKV: async () => {
            const llamaContext = get().context
            if (!llamaContext) {
                Logger.log('No Model Loaded', true)
                return
            }
            if (!(await FS.getInfoAsync(sessionFileDir)).exists) {
                await FS.makeDirectoryAsync(sessionFileDir)
            }

            if (!(await FS.getInfoAsync(sessionFile)).exists) {
                await FS.writeAsStringAsync(sessionFile, '', { encoding: 'base64' })
            }

            const now = performance.now()
            const data = await llamaContext.saveSession(sessionFile.replace('file://', ''))
            Logger.log(
                data === -1
                    ? 'Failed to save KV cache'
                    : `Saved KV in ${Math.floor(performance.now() - now)}ms with ${data} tokens`
            )
            Logger.log(`Current KV Size is: ${await getKVSizeMB()}MB`)
        },
        loadKV: async () => {
            const llamaContext = get().context
            if (!llamaContext) {
                Logger.log('No Model Loaded', true)
                return
            }
            const data = await FS.getInfoAsync(sessionFile)
            if (!data.exists) {
                Logger.log('No cache found')
                return
            }
            await llamaContext
                .loadSession(sessionFile.replace('file://', ''))
                .then(() => {
                    Logger.log('Session loaded from KV cache')
                })
                .catch(() => {
                    Logger.log('Session loaded could not load from KV cache')
                })
        },
        tokenLength: async () => {
            return -1
        },
    }))

    const textTimings = (timings: CompletionTimings) => {
        return (
            `\n[Prompt Timings]` +
            `\nPrompt Per Token: ${timings.prompt_per_token_ms} ms/token` +
            `\nPrompt Per Second: ${timings.prompt_per_second?.toFixed(2) ?? 0} tokens/s` +
            `\nPrompt Time: ${(timings.prompt_ms / 1000).toFixed(2)}s` +
            `\nPrompt Tokens: ${timings.prompt_n} tokens` +
            `\n\n[Predicted Timings]` +
            `\nPredicted Per Token: ${timings.predicted_per_token_ms} ms/token` +
            `\nPredicted Per Second: ${timings.predicted_per_second?.toFixed(2) ?? 0} tokens/s` +
            `\nPrediction Time: ${(timings.predicted_ms / 1000).toFixed(2)}s` +
            `\nPredicted Tokens: ${timings.predicted_n} tokens`
        )
    }

    /*
    let llamaContext: LlamaContext | void = undefined
    let modelname: string | undefined = undefined

    // Model Functions

    export const loadModel = async (
        name: string,
        preset: LlamaPreset = default_preset,
        usecache: boolean = true
    ) => {
        const newname = name
        const dir = `${model_dir}${name}`

        if (newname === '') {
            Logger.log('No Model Chosen', true)
            return
        }

        if (newname === modelname) {
            Logger.log('Model Already Loaded!', true)
            return
        }

        if (usecache && !(await modelExists(name))) {
            Logger.log('Model Does Not Exist!', true)
            return
        }

        if (llamaContext !== undefined) {
            Logger.log('Unloading current model', true)
            await llamaContext?.release()
            modelname = undefined
        }

        const params = {
            model: dir,
            n_ctx: preset.context_length,
            n_threads: preset.threads,
            n_batch: preset.batch,
            n_gpu_layers: Platform.OS === 'ios' ? preset.gpu_layers : 0,
        }

        mmkv.set(Global.LocalSessionLoaded, false)
        Logger.log(`Loading Model: ${newname}`, true)
        Logger.log(JSON.stringify(params))

        llamaContext = await initLlama(params)
            .then((ctx) => {
                modelname = newname
                Logger.log('Model Loaded', true)
                return ctx
            })
            .catch((error) => {
                Logger.log(`Could Not Load Model: ${error} `, true)
            })
    }

    export const completion = async (
        params: CompletionParams,
        callback = (text: string) => {},
        completed = (text: string) => {}
    ) => {
        if (llamaContext === undefined) {
            Logger.log('No Model Loaded', true)
            return
        }

        return llamaContext
            .completion(params, (data: any) => {
                callback(data.token)
            })
            .then(async ({ text, timings }: CompletionOutput) => {
                completed(text)
                Logger.log(`Completion Output:\n\n` + text)
                Logger.log(textTimings(timings))
                if (mmkv.getBoolean(AppSettings.SaveLocalKV)) {
                    await saveKV()
                }
            })
    }

    

    export const stopCompletion = async () => {
        return await llamaContext?.stopCompletion()
    }

    export const getDetails = () => {
        if (llamaContext) return llamaContext.model
    }

    export const unloadModel = async () => {
        Logger.log('Unloading Model', true)
        await llamaContext?.release()
        modelname = undefined
        llamaContext = undefined
        Logger.log('Model Unloaded', true)
    }

    export const isModelLoaded = (showmessage = true) => {
        if (showmessage && llamaContext === undefined) {
            Logger.log('No Model Loaded', true)
        }
        return llamaContext !== undefined
    }

    export const getModelname = () => {
        return modelname
    }

    export const saveKV = async () => {
        if (!llamaContext) {
            Logger.log('No Model Loaded', true)
            return
        }
        if (!(await FS.getInfoAsync(sessionFileDir)).exists) {
            await FS.makeDirectoryAsync(sessionFileDir)
        }

        if (!(await FS.getInfoAsync(sessionFile)).exists) {
            await FS.writeAsStringAsync(sessionFile, '', { encoding: 'base64' })
        }

        const now = performance.now()
        const data = await llamaContext.saveSession(sessionFile.replace('file://', ''))
        Logger.log(
            data === -1
                ? 'Failed to save KV cache'
                : `Saved KV in ${Math.floor(performance.now() - now)}ms with ${data} tokens`
        )
        Logger.log(`Current KV Size is: ${await getKVSizeMB()}MB`)
    }

    export const loadKV = async () => {
        if (!llamaContext) {
            Logger.log('No Model Loaded', true)
            return
        }
        const data = await FS.getInfoAsync(sessionFile)
        if (!data.exists) {
            Logger.log('No cache found')
            return
        }
        await llamaContext
            .loadSession(sessionFile.replace('file://', ''))
            .then(() => {
                Logger.log('Session loaded from KV cache')
            })
            .catch(() => {
                Logger.log('Session loaded could not load from KV cache')
            })
    }

    export const tokenLength = async (text: string) => {
        if (!llamaContext) return -1
        return (await llamaContext.tokenize(text)).tokens.length
    }*/

    // Presets

    export const setLlamaPreset = () => {
        const presets = mmkv.getString(Global.LocalPreset)
        if (presets === undefined) mmkv.set(Global.LocalPreset, JSON.stringify(default_preset))
    }

    // Downloaders

    export const downloadModel = async (url: string) => {
        const modelName = nameFromURL(url)
        const modelList = await Llama.getModelList()
        if (modelList.includes(modelName)) {
            Logger.log('Model already exists!', true)
            return
        }
        Logger.log('Downloading Model...', true)
        await FS.downloadAsync(url, `${model_dir}${modelName}`)
            .then(() => {
                Logger.log('Model downloaded!', true)
            })
            .catch(() => {
                Logger.log('Download failed', true)
            })
    }

    export const nameFromURL = (url: string) => {
        return url.split('resolve/main/')[1].replace('?download=true', '')
    }

    // Filesystem

    export const getModelList = async () => {
        return await FS.readDirectoryAsync(model_dir)
    }

    export const modelExists = async (modelName: string) => {
        return (await getModelList()).includes(modelName)
    }

    export const deleteModel = async (name: string) => {
        if (!(await modelExists(name))) return
        if (name === useLlama.getState().modelname) await useLlama.getState().unload()
        return await FS.deleteAsync(`${model_dir}${name}`)
    }

    export const importModel = async () => {
        return DocumentPicker.pickSingle()
            .then(async (result: any) => {
                if (DocumentPicker.isCancel(result)) return false
                const name = result.name
                Logger.log('Importing file...', true)
                await FS.copyAsync({
                    from: result.uri,
                    to: `${model_dir}${name}`,
                })
                    .then(() => {
                        Logger.log('File Imported!', true)
                    })
                    .catch((error) => {
                        Logger.log(`Import Failed: ${error.message}`, true)
                    })

                return false
            })
            .catch(() => {
                Logger.log('No Model Chosen', true)
            })
    }

    export const getKVSizeMB = async () => {
        const data = await FS.getInfoAsync(sessionFile)
        if (!data.exists) {
            return 0
        }
        return Math.floor(data.size * 0.000001)
    }

    export const deleteKV = async () => {
        if ((await FS.getInfoAsync(sessionFile)).exists) {
            await FS.deleteAsync(sessionFile)
        }
    }

    export const kvInfo = async () => {
        const data = await FS.getInfoAsync(sessionFile)
        if (!data.exists) {
            Logger.log('No KV Cache found')
            return
        }
        Logger.log(`Size of KV cache: ${Math.floor(data.size * 0.000001)} MB`)
    }
}
