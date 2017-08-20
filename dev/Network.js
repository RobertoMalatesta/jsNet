"use strict"

class Network {

    constructor ({learningRate, layers=[], adaptiveLR="noadaptivelr", activation="sigmoid", cost="meansquarederror",
        rmsDecay, rho, lreluSlope, eluAlpha, dropout=1, l2=true, l1=true, maxNorm, weightsConfig, filterSize,
        zeroPadding, stride, channels, filterCount}={}) {

        this.state = "not-defined"
        this.layers = []
        this.epochs = 0
        this.iterations = 0
        this.dropout = dropout==false ? 1 : dropout
        this.error = 0
        activation = NetUtil.format(activation)
        adaptiveLR = NetUtil.format(adaptiveLR)
        cost = NetUtil.format(cost)

        if (l2) {
            this.l2 = typeof l2=="boolean" ? 0.001 : l2
            this.l2Error = 0
        }

        if (l1) {
            this.l1 = typeof l1=="boolean" ? 0.005 : l1
            this.l1Error = 0
        }

        if (maxNorm) {
            this.maxNorm = typeof maxNorm=="boolean" && maxNorm ? 1000 : maxNorm
            this.maxNormTotal = 0
        }

        if (learningRate)   this.learningRate = learningRate
        if (filterSize)     this.filterSize = filterSize
        if (zeroPadding)    this.zeroPadding = zeroPadding
        if (stride)         this.stride = stride
        if (channels)       this.channels = channels
        if (filterCount)    this.filterCount = filterCount

        // Activation function / Learning Rate
        switch (adaptiveLR) {

            case "rmsprop":
                this.learningRate = this.learningRate==undefined ? 0.001 : this.learningRate
                break

            case "adam":
                this.learningRate = this.learningRate==undefined ? 0.01 : this.learningRate
                break

            case "adadelta":
                this.rho = rho==null ? 0.95 : rho
                break

            default:

                if (this.learningRate==undefined) {

                    switch (activation) {

                        case "relu":
                        case "lrelu":
                        case "rrelu":
                        case "elu":
                            this.learningRate = 0.01
                            break

                        case "tanh":
                        case "lecuntanh":
                            this.learningRate = 0.001
                            break

                        default:
                            this.learningRate = 0.2
                    }
                }
        }

        this.adaptiveLR = [false, null, undefined].includes(adaptiveLR) ? "noadaptivelr" : adaptiveLR
        this.weightUpdateFn = NetMath[this.adaptiveLR]
        this.activation = typeof activation=="function" ? activation : NetMath[activation].bind(this)
        this.activationConfig = activation
        this.cost = typeof cost=="function" ? cost : NetMath[cost]

        if (this.adaptiveLR=="rmsprop") {
            this.rmsDecay = rmsDecay==undefined ? 0.99 : rmsDecay
        }

        this.lreluSlope = lreluSlope==undefined ? -0.0005 : lreluSlope
        this.eluAlpha = eluAlpha==undefined ? 1 : eluAlpha

        // Weights distributiom
        this.weightsConfig = {distribution: "xavieruniform"}

        if (weightsConfig != undefined && weightsConfig.distribution) {
            this.weightsConfig.distribution = NetUtil.format(weightsConfig.distribution)
        }

        if (this.weightsConfig.distribution == "uniform") {
            this.weightsConfig.limit = weightsConfig && weightsConfig.limit!=undefined ? weightsConfig.limit : 0.1

        } else if (this.weightsConfig.distribution == "gaussian") {
            this.weightsConfig.mean = weightsConfig.mean || 0
            this.weightsConfig.stdDeviation = weightsConfig.stdDeviation || 0.05
        }

        if (typeof this.weightsConfig.distribution=="function") {
            this.weightsInitFn = this.weightsConfig.distribution
        } else {
            this.weightsInitFn = NetMath[this.weightsConfig.distribution]
        }

        // Status
        if (layers.length) {

            switch (true) {

                case layers.every(item => Number.isInteger(item)):
                    this.layers = layers.map(size => new FCLayer(size))
                    this.state = "constructed"
                    this.initLayers()
                    break

                case layers.every(item => item instanceof FCLayer || item instanceof ConvLayer):
                    this.state = "constructed"
                    this.layers = layers
                    this.initLayers()
                    break

                default:
                    throw new Error("There was an error constructing from the layers given.")
            }
        }
    }

    initLayers (input, expected) {

        switch (this.state) {

            case "initialised":
                return

            case "not-defined":
                this.layers[0] = new FCLayer(input)
                this.layers[1] = new FCLayer(Math.ceil(input/expected > 5 ? expected + (Math.abs(input-expected))/4
                                                                        : input + expected))
                this.layers[2] = new FCLayer(Math.ceil(expected))
                break
        }

        this.layers.forEach(this.joinLayer.bind(this))
        this.state = "initialised"
    }

    joinLayer (layer, layerIndex) {

        layer.net = this
        layer.activation = layer.activation || this.activation

        layer.weightsConfig = {}
        Object.assign(layer.weightsConfig, this.weightsConfig)

        if (layerIndex) {
            this.layers[layerIndex-1].assignNext(layer)
            layer.assignPrev(this.layers[layerIndex-1])

            layer.weightsConfig.fanIn = layer.prevLayer.size
            layer.prevLayer.weightsConfig.fanOut = layer.size

            layer.init()
            layer.state = "initialised"
        }
    }

    forward (data) {

        if (this.state!="initialised") {
            throw new Error("The network layers have not been initialised.")
        }

        if (data === undefined || data === null) {
            throw new Error("No data passed to Network.forward()")
        }

        if (data.length != this.layers[0].neurons.length) {
            console.warn("Input data length did not match input layer neurons count.")
        }

        this.layers[0].neurons.forEach((neuron, ni) => neuron.activation = data[ni])
        this.layers.forEach((layer, li) => li && layer.forward(data))
        return this.layers[this.layers.length-1].neurons.map(n => n.activation)
    }

    backward (expected) {

        if (expected === undefined) {
            throw new Error("No data passed to Network.backward()")
        }

        if (expected.length != this.layers[this.layers.length-1].neurons.length) {
            console.warn("Expected data length did not match output layer neurons count.", expected)
        }

        this.layers[this.layers.length-1].backward(expected)

        for (let layerIndex=this.layers.length-2; layerIndex>0; layerIndex--) {
            this.layers[layerIndex].backward()
        }
    }

    train (dataSet, {epochs=1, callback, log=true, miniBatchSize=1, shuffle=false}={}) {

        this.miniBatchSize = typeof miniBatchSize=="boolean" && miniBatchSize ? dataSet[0].expected.length : miniBatchSize

        if (shuffle) {
            NetUtil.shuffle(dataSet)
        }

        if (log) {
            console.log(`Training started. Epochs: ${epochs} Batch Size: ${this.miniBatchSize}`)
        }

        return new Promise((resolve, reject) => {

            if (dataSet === undefined || dataSet === null) {
                return void reject("No data provided")
            }

            if (this.state != "initialised") {
                this.initLayers(dataSet[0].input.length, (dataSet[0].expected || dataSet[0].output).length)
            }

            this.layers.forEach(layer => layer.state = "training")

            let iterationIndex = 0
            let epochsCounter = 0
            const startTime = Date.now()

            const doEpoch = () => {
                this.epochs++
                this.error = 0
                iterationIndex = 0

                if (this.l2Error!=undefined) this.l2Error = 0
                if (this.l1Error!=undefined) this.l1Error = 0

                doIteration()
            }

            const doIteration = () => {

                if (!dataSet[iterationIndex].hasOwnProperty("input") || (!dataSet[iterationIndex].hasOwnProperty("expected") && !dataSet[iterationIndex].hasOwnProperty("output"))) {
                    return void reject("Data set must be a list of objects with keys: 'input' and 'expected' (or 'output')")
                }

                const input = dataSet[iterationIndex].input
                const output = this.forward(input)
                const target = dataSet[iterationIndex].expected || dataSet[iterationIndex].output

                this.backward(target)

                if (++iterationIndex%this.miniBatchSize==0) {
                    this.applyDeltaWeights()
                    this.resetDeltaWeights()
                } else if (iterationIndex >= dataSet.length) {
                    this.applyDeltaWeights()
                }

                const iterationError = this.cost(target, output)
                const elapsed = Date.now() - startTime
                this.error += iterationError
                this.iterations++

                if (typeof callback=="function") {
                    callback({
                        iterations: this.iterations,
                        error: iterationError,
                        elapsed, input
                    })
                }

                if (iterationIndex < dataSet.length) {
                    setTimeout(doIteration.bind(this), 0)

                } else {
                    epochsCounter++

                    if (log) {
                        console.log(`Epoch: ${this.epochs} Error: ${this.error/iterationIndex}${this.l2==undefined ? "": ` L2 Error: ${this.l2Error/iterationIndex}`}`,
                                    `\nElapsed: ${NetUtil.format(elapsed, "time")} Average Duration: ${NetUtil.format(elapsed/epochsCounter, "time")}`)
                    }

                    if (epochsCounter < epochs) {
                        doEpoch()
                    } else {
                        this.layers.forEach(layer => layer.state = "initialised")

                        if (log) {
                            console.log(`Training finished. Total time: ${NetUtil.format(elapsed, "time")}  Average iteration time: ${NetUtil.format(elapsed/iterationIndex, "time")}`)
                        }
                        resolve()
                    }
                }
            }

            this.resetDeltaWeights()
            doEpoch()
        })
    }

    test (testSet, {log=true, callback}={}) {
        return new Promise((resolve, reject) => {

            if (testSet === undefined || testSet === null) {
                reject("No data provided")
            }

            if (log) {
                console.log("Testing started")
            }

            let totalError = 0
            let iterationIndex = 0
            const startTime = Date.now()

            const testInput = () => {

                const input = testSet[iterationIndex].input
                const output = this.forward(input)
                const target = testSet[iterationIndex].expected || testSet[iterationIndex].output
                const elapsed = Date.now() - startTime

                const iterationError = this.cost(target, output)
                totalError += iterationError
                iterationIndex++

                if (typeof callback=="function") {
                    callback({
                        iterations: iterationIndex,
                        error: iterationError,
                        elapsed, input
                    })
                }

                if (iterationIndex < testSet.length) {
                    setTimeout(testInput.bind(this), 0)

                } else {

                    if (log) {
                        console.log(`Testing finished. Total time: ${NetUtil.format(elapsed, "time")}  Average iteration time: ${NetUtil.format(elapsed/iterationIndex, "time")}`)
                    }

                    resolve(totalError/testSet.length)
                }
            }
            testInput()
        })
    }

    resetDeltaWeights () {
        this.layers.forEach((layer, li) => li && layer.resetDeltaWeights())
    }

    applyDeltaWeights () {

        this.layers.forEach((layer, li) => li && layer.applyDeltaWeights())

        if (this.maxNorm!=undefined) {
            this.maxNormTotal = Math.sqrt(this.maxNormTotal)
            NetMath.maxNorm.bind(this)()
        }
    }

    toJSON () {
        return {
            layers: this.layers.map(layer => layer.toJSON())
        }
    }

    fromJSON (data) {

        if (data === undefined || data === null) {
            throw new Error("No JSON data given to import.")
        }

        if (data.layers.length != this.layers.length) {
            throw new Error(`Mismatched layers (${data.layers.length} layers in import data, but ${this.layers.length} configured)`)
        }

        this.resetDeltaWeights()
        this.layers.forEach((layer, li) => li && layer.fromJSON(data.layers[li], li))
    }

    static get version () {
        return "2.0.0"
    }
}

typeof window=="undefined" && (exports.Network = Network)