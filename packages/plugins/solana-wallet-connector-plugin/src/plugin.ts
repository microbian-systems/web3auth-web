import type { JsonRpcError } from "@metamask/rpc-errors";
import { SafeEventEmitter } from "@toruslabs/openlogin-jrpc";
import TorusEmbed, { NetworkInterface, PAYMENT_PROVIDER_TYPE, PaymentParams, TorusCtorArgs, TorusParams } from "@toruslabs/solana-embed";
import {
  ADAPTER_EVENTS,
  CustomChainConfig,
  IPlugin,
  IWeb3Auth,
  PLUGIN_EVENTS,
  PLUGIN_NAMESPACES,
  SafeEventEmitterProvider,
  SOLANA_PLUGINS,
  UserInfo,
  WALLET_ADAPTERS,
} from "@web3auth/base";
import log from "loglevel";

import { SolanaWalletPluginError } from "./errors";

export type ProviderInfo = {
  provider?: SafeEventEmitterProvider;
  userInfo?: Omit<UserInfo, "isNewUser">;
};

export class SolanaWalletConnectorPlugin extends SafeEventEmitter implements IPlugin {
  name = SOLANA_PLUGINS.SOLANA;

  readonly SUPPORTED_ADAPTERS = [WALLET_ADAPTERS.OPENLOGIN];

  readonly pluginNamespace = PLUGIN_NAMESPACES.SOLANA;

  public torusWalletInstance: TorusEmbed;

  private provider: SafeEventEmitterProvider | null = null;

  private web3auth: IWeb3Auth | null = null;

  private userInfo: UserInfo | null = null;

  private isInitialized = false;

  private walletInitOptions: TorusParams | null = null;

  constructor(options: { torusWalletOpts?: TorusCtorArgs; walletInitOptions: Partial<TorusParams> }) {
    super();
    const { torusWalletOpts = {}, walletInitOptions } = options;
    // const whiteLabel = walletInitOptions?.whiteLabel;

    // if (!whiteLabel) throw new Error("whiteLabel is required");
    // const { logoDark, logoLight } = whiteLabel;
    // if (!logoDark || !logoLight) throw new Error("logoDark and logoLight are required in whiteLabel config");

    this.torusWalletInstance = new TorusEmbed(torusWalletOpts);
    this.walletInitOptions = walletInitOptions;
  }

  get proxyProvider(): SafeEventEmitterProvider | null {
    return this.torusWalletInstance.isLoggedIn ? (this.torusWalletInstance.provider as unknown as SafeEventEmitterProvider) : null;
  }

  async initWithWeb3Auth(web3auth: IWeb3Auth): Promise<void> {
    if (this.isInitialized) return;
    if (!web3auth) throw SolanaWalletPluginError.web3authRequired();
    if (web3auth.provider && web3auth.connectedAdapterName !== WALLET_ADAPTERS.OPENLOGIN) throw SolanaWalletPluginError.unsupportedAdapter();
    if (web3auth.coreOptions.chainConfig.chainNamespace !== this.pluginNamespace) throw SolanaWalletPluginError.unsupportedChainNamespace();
    // Not connected yet to openlogin
    if (web3auth.provider) {
      this.provider = web3auth.provider;
      this.userInfo = (await web3auth.getUserInfo()) as UserInfo;
    }
    this.web3auth = web3auth;
    this.subscribeToWeb3AuthNoModalEvents(web3auth);

    const connectedChainConfig = web3auth.coreOptions.chainConfig as CustomChainConfig;
    if (!connectedChainConfig.blockExplorerUrl) throw SolanaWalletPluginError.invalidParams("blockExplorerUrl is required in chainConfig");
    if (!connectedChainConfig.displayName) throw SolanaWalletPluginError.invalidParams("displayName is required in chainConfig");
    if (!connectedChainConfig.logo) throw SolanaWalletPluginError.invalidParams("logo is required in chainConfig");
    if (!connectedChainConfig.ticker) throw SolanaWalletPluginError.invalidParams("ticker is required in chainConfig");
    if (!connectedChainConfig.tickerName) throw SolanaWalletPluginError.invalidParams("tickerName is required in chainConfig");

    await this.torusWalletInstance.init({
      ...(this.walletInitOptions || {}),
      network: {
        ...connectedChainConfig,
        blockExplorerUrl: connectedChainConfig.blockExplorerUrl,
        logo: connectedChainConfig.logo,
        chainId: connectedChainConfig.chainId,
        rpcTarget: connectedChainConfig.rpcTarget,
        displayName: connectedChainConfig.displayName,
      } as NetworkInterface,
      showTorusButton: false,
    });
    this.isInitialized = true;
    this.emit(PLUGIN_EVENTS.READY);
  }

  async initWithProvider(provider: SafeEventEmitterProvider, userInfo: UserInfo): Promise<void> {
    if (this.isInitialized) return;

    if (!userInfo) throw SolanaWalletPluginError.userInfoRequired();
    if (!provider) throw SolanaWalletPluginError.providerRequired();

    this.provider = provider;
    this.userInfo = userInfo;
    await this.torusWalletInstance.init(this.walletInitOptions || {});
    this.isInitialized = true;
    this.emit(PLUGIN_EVENTS.READY);
  }

  async connect(): Promise<void> {
    // if web3auth is being used and connected to unsupported adapter throw error
    if (this.web3auth && this.web3auth.connectedAdapterName !== WALLET_ADAPTERS.OPENLOGIN) throw SolanaWalletPluginError.unsupportedAdapter();
    if (!this.isInitialized) throw SolanaWalletPluginError.notInitialized();
    this.emit(PLUGIN_EVENTS.CONNECTING);
    // Not connected yet to openlogin
    if (!this.provider) {
      if (this.web3auth?.provider) {
        this.provider = this.web3auth.provider;
        this.userInfo = (await this.web3auth.getUserInfo()) as UserInfo;
      } else if (this.web3auth) {
        throw SolanaWalletPluginError.web3AuthNotConnected();
      } else {
        throw SolanaWalletPluginError.providerRequired();
      }
    }
    let privateKey: string | undefined;

    try {
      // it should throw if provider doesn't support `solanaSecretKey` function
      privateKey = (await this.provider.request<never, string>({ method: "solanaSecretKey" })) as string;
    } catch (error: unknown) {
      log.warn("unsupported method", error, SolanaWalletPluginError.unsupportedAdapter());
      if ((error as JsonRpcError<never>)?.code === -32004) throw SolanaWalletPluginError.unsupportedAdapter();
      throw error;
    }
    if (!privateKey) throw SolanaWalletPluginError.web3AuthNotConnected();
    try {
      await this.torusWalletInstance.loginWithPrivateKey({
        privateKey,
        userInfo: {
          ...(this.userInfo as Omit<UserInfo, "isNewUser">),
          email: this.userInfo?.email as string,
          name: this.userInfo?.name as string,
          profileImage: this.userInfo?.profileImage as string,
        },
      });
      this.torusWalletInstance.showTorusButton();
      this.subscribeToProviderEvents(this.provider);
      this.emit(PLUGIN_EVENTS.CONNECTED);
    } catch (error: unknown) {
      log.error(error);
      this.emit(PLUGIN_EVENTS.ERRORED, { error: (error as Error).message || "Something went wrong" });
    }
  }

  async initiateTopup(provider: PAYMENT_PROVIDER_TYPE, params: PaymentParams): Promise<void> {
    if (!this.torusWalletInstance.isLoggedIn) throw SolanaWalletPluginError.web3AuthNotConnected();
    await this.torusWalletInstance.initiateTopup(provider, params);
  }

  async disconnect(): Promise<void> {
    // if web3auth is being used and connected to unsupported adapter throw error
    if (this.web3auth?.connectedAdapterName !== WALLET_ADAPTERS.OPENLOGIN) throw SolanaWalletPluginError.unsupportedAdapter();
    if (this.torusWalletInstance.isLoggedIn) {
      await this.torusWalletInstance.logout();
      this.emit(PLUGIN_EVENTS.DISCONNECTED);
    } else {
      throw new Error("Torus Wallet plugin is not connected");
    }
  }

  private subscribeToProviderEvents(provider: SafeEventEmitterProvider) {
    provider.on("accountsChanged", (data: { accounts: string[] }) => {
      this.setSelectedAddress(data.accounts[0]);
    });

    provider.on("chainChanged", (chainId: string) => {
      this.setChainID(parseInt(chainId, 16));
    });
    provider.on("disconnect", () => {
      this.torusWalletInstance.hideTorusButton();
    });
    provider.on("connect", () => {
      this.torusWalletInstance.showTorusButton();
    });
  }

  private subscribeToWeb3AuthNoModalEvents(web3Auth: IWeb3Auth) {
    web3Auth.on(ADAPTER_EVENTS.CONNECTED, async () => {
      if (web3Auth.connectedAdapterName !== WALLET_ADAPTERS.OPENLOGIN) {
        log.warn(`${web3Auth.connectedAdapterName} is not compatible with torus wallet connector plugin`);
        return;
      }
      this.provider = web3Auth.provider;
      this.userInfo = (await web3Auth.getUserInfo()) as Omit<UserInfo, "isNewUser">;
      if (!this.provider) throw SolanaWalletPluginError.web3AuthNotConnected();
      this.subscribeToProviderEvents(this.provider);
    });

    web3Auth.on(ADAPTER_EVENTS.DISCONNECTED, async () => {
      this.provider = null;
      this.userInfo = null;
      if (this.torusWalletInstance.isLoggedIn) {
        await this.torusWalletInstance.logout();
      }
      this.torusWalletInstance.hideTorusButton();
    });
  }

  private async sessionConfig(): Promise<{ chainId: number; accounts: string[]; privateKey: string; chainConfig: CustomChainConfig }> {
    if (!this.provider) throw SolanaWalletPluginError.web3AuthNotConnected();
    const [accounts, chainId, privateKey, chainConfig] = await Promise.all([
      this.provider.request<never, string[]>({ method: "requestAccounts" }),
      this.provider.request<never, string>({ method: "solana_chainId" }),
      this.provider.request<never, string>({ method: "solanaSecretKey" }),
      this.provider.request<never, CustomChainConfig>({ method: "solana_provider_config" }),
    ]);
    return {
      chainId: parseInt(chainId as string, 16),
      accounts: accounts as string[],
      privateKey: privateKey as string,
      chainConfig: chainConfig as CustomChainConfig,
    };
  }

  private async torusWalletSessionConfig(): Promise<{ chainId: number; accounts: string[] }> {
    if (!this.torusWalletInstance.provider) throw SolanaWalletPluginError.web3AuthNotConnected();
    const [accounts, chainId] = await Promise.all([
      this.torusWalletInstance.provider.request<never, string[]>({ method: "solana_accounts" }),
      this.torusWalletInstance.provider.request<never, string>({ method: "solana_chainId" }),
    ]);
    return {
      chainId: parseInt(chainId as string, 16),
      accounts: accounts as string[],
    };
  }

  private async setSelectedAddress(address: string): Promise<void> {
    if (!this.torusWalletInstance.isLoggedIn || !this.userInfo) throw SolanaWalletPluginError.web3AuthNotConnected();
    const [sessionConfig, torusWalletSessionConfig] = await Promise.all([this.sessionConfig(), this.torusWalletSessionConfig()]);
    if (address !== torusWalletSessionConfig.accounts?.[0]) {
      await this.torusWalletInstance.loginWithPrivateKey({
        privateKey: sessionConfig.privateKey,
        userInfo: {
          ...this.userInfo,
          email: this.userInfo?.email as string,
          name: this.userInfo?.name as string,
          profileImage: this.userInfo?.profileImage as string,
        },
      });
    }
  }

  private async setChainID(chainId: number): Promise<void> {
    const [sessionConfig, torusWalletSessionConfig] = await Promise.all([this.sessionConfig(), this.torusWalletSessionConfig()]);
    const { chainConfig } = sessionConfig || {};
    if (chainId !== torusWalletSessionConfig.chainId && chainConfig) {
      await this.torusWalletInstance.setProvider({
        ticker: chainConfig.ticker,
        tickerName: chainConfig.tickerName,
        blockExplorerUrl: chainConfig.blockExplorerUrl,
        logo: chainConfig.logo,
        chainId: `0x${chainId.toString(16)}`,
        rpcTarget: chainConfig.rpcTarget,
        displayName: chainConfig.displayName,
      });
    }
  }
}
