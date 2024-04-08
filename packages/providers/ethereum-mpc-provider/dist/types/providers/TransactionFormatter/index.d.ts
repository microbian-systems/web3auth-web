import { Common } from "@ethereumjs/common";
import { SafeEventEmitterProvider } from "@web3auth/base";
import { TransactionParams } from "../../rpc/interfaces";
export declare class TransactionFormatter {
    readonly API_SUPPORTED_CHAINIDS: Set<string>;
    private chainConfig;
    private getProviderEngineProxy;
    private isEIP1559Compatible;
    constructor({ getProviderEngineProxy }: {
        getProviderEngineProxy: () => SafeEventEmitterProvider;
    });
    get providerProxy(): SafeEventEmitterProvider;
    init(): Promise<void>;
    getCommonConfiguration(): Promise<Common>;
    formatTransaction(txParams: TransactionParams & {
        gas?: string;
    }): Promise<TransactionParams & {
        gas?: string;
    }>;
    private fetchEthGasPriceEstimate;
    private fetchGasEstimatesViaEthFeeHistory;
    private getEIP1559Compatibility;
    private fetchGasFeeEstimateData;
    private getDefaultGasFees;
    private estimateTxGas;
    private analyzeGasUsage;
    private addGasBuffer;
    private determineTransactionCategory;
    private getDefaultGasLimit;
}
