import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NearbyEndpoint { endpointId: string; name: string }
export interface NearbyVerification extends NearbyEndpoint { code: string }
export interface NearbyPayload { endpointId: string; payload: string }

interface NearbyConnectionsPlugin {
  isAvailable(): Promise<{ available: boolean; permissionAliases?: string[] }>;
  requestPermissions(options?: { permissions?: string[] }): Promise<Record<string, string>>;
  requestNotificationPermission(): Promise<void>;
  ensurePermissions(): Promise<void>;
  startAdvertising(options: { name: string }): Promise<void>;
  stopAdvertising(): Promise<void>;
  startDiscovery(options: { name: string }): Promise<void>;
  stopDiscovery(): Promise<void>;
  setKeepAwake(options: { enabled: boolean }): Promise<void>;
  requestConnection(options: { endpointId: string; name: string }): Promise<void>;
  acceptVerification(options: { endpointId: string; accept: boolean }): Promise<void>;
  send(options: { endpointIds: string[]; payload: string }): Promise<void>;
  disconnect(options: { endpointId: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'endpointFound' | 'endpointLost' | 'connected' | 'disconnected', listener: (event: NearbyEndpoint) => void): Promise<PluginListenerHandle>;
  addListener(event: 'verificationRequired', listener: (event: NearbyVerification) => void): Promise<PluginListenerHandle>;
  addListener(event: 'payloadReceived', listener: (event: NearbyPayload) => void): Promise<PluginListenerHandle>;
}

export const NearbyConnections = registerPlugin<NearbyConnectionsPlugin>('NearbyConnections');
export const isNativeNearby = (): boolean => Capacitor.isNativePlatform();
