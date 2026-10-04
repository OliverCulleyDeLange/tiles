import Capacitor
import CoreLocation
import Foundation
import NearbyConnections
import UIKit
import UserNotifications

@objc(NearbyConnectionsPlugin)
public class NearbyConnectionsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NearbyConnectionsPlugin"
    public let jsName = "NearbyConnections"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptVerification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let serviceID = "uk.co.oliverdelange.tiles.nearby"
    private let locationManager = CLLocationManager()
    private var manager: ConnectionManager?
    private var advertiser: Advertiser?
    private var discoverer: Discoverer?
    private var endpointNames: [EndpointID: String] = [:]
    private var verifications: [EndpointID: (Bool) -> Void] = [:]
    private var connectedEndpoints: Set<EndpointID> = []
    private var localName = "Tiles player"
    private var isAdvertising = false
    private var isDiscovering = false
    private var isStopping = false
    private var stopCompletions: [() -> Void] = []

    public override func load() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIScene.didEnterBackgroundNotification,
            object: nil
        )
    }

    @objc private func appDidEnterBackground() {
        stopNearbySession()
    }

    @objc public func isAvailable(_ call: CAPPluginCall) { call.resolve(["available": true]) }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.locationManager.requestWhenInUseAuthorization()
            call.resolve(["nearby": "prompted"])
        }
    }

    @objc public func requestNotificationPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
            call.resolve()
        }
    }

    private func configure() -> ConnectionManager {
        let value = ConnectionManager(serviceID: serviceID, strategy: .cluster)
        value.delegate = self
        manager = value
        return value
    }

    @objc public func startAdvertising(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Nearby plugin is unavailable"); return }
            self.localName = call.getString("name") ?? self.localName
            if self.isAdvertising { call.resolve(); return }
            let value: Advertiser
            if let current = self.advertiser {
                value = current
            } else {
                value = Advertiser(connectionManager: self.manager ?? self.configure())
                value.delegate = self
                self.advertiser = value
            }
            self.isAdvertising = true
            value.startAdvertising(using: Data(self.localName.utf8)) { error in
                DispatchQueue.main.async {
                    if let error {
                        self.isAdvertising = false
                        call.reject(error.localizedDescription)
                    } else {
                        call.resolve()
                    }
                }
            }
        }
    }

    @objc public func stopAdvertising(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isAdvertising, let advertiser = self.advertiser else { call.resolve(); return }
            self.isAdvertising = false
            advertiser.stopAdvertising { error in
                DispatchQueue.main.async {
                    if let error { call.reject(error.localizedDescription) }
                    else { call.resolve() }
                }
            }
        }
    }

    @objc public func startDiscovery(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Nearby plugin is unavailable"); return }
            self.localName = call.getString("name") ?? self.localName
            if self.isDiscovering { call.resolve(); return }
            let value: Discoverer
            if let current = self.discoverer {
                value = current
            } else {
                value = Discoverer(connectionManager: self.manager ?? self.configure())
                value.delegate = self
                self.discoverer = value
            }
            self.isDiscovering = true
            value.startDiscovery { error in
                DispatchQueue.main.async {
                    if let error {
                        self.isDiscovering = false
                        call.reject(error.localizedDescription)
                    } else {
                        call.resolve()
                    }
                }
            }
        }
    }

    @objc public func stopDiscovery(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isDiscovering, let discoverer = self.discoverer else { call.resolve(); return }
            self.isDiscovering = false
            discoverer.stopDiscovery { error in
                DispatchQueue.main.async {
                    if let error { call.reject(error.localizedDescription) }
                    else { call.resolve() }
                }
            }
        }
    }

    @objc public func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve()
        }
    }

    @objc public func requestConnection(_ call: CAPPluginCall) {
        guard let endpointID = call.getString("endpointId") else { call.reject("endpointId is required"); return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let discoverer = self.discoverer else { call.reject("Discovery is not active"); return }
            discoverer.requestConnection(to: endpointID, using: Data(self.localName.utf8)) { error in
                DispatchQueue.main.async {
                    if let error { call.reject(error.localizedDescription) }
                    else { call.resolve() }
                }
            }
        }
    }

    @objc public func acceptVerification(_ call: CAPPluginCall) {
        guard let endpointID = call.getString("endpointId") else { call.reject("endpointId is required"); return }
        DispatchQueue.main.async { [weak self] in
            guard let self, let handler = self.verifications.removeValue(forKey: endpointID) else {
                call.reject("No pending verification"); return
            }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["invite-\(endpointID)"])
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["invite-\(endpointID)"])
            handler(call.getBool("accept") ?? false)
            call.resolve()
        }
    }

    @objc public func send(_ call: CAPPluginCall) {
        guard let endpointIDs = call.getArray("endpointIds", String.self), let payload = call.getString("payload") else {
            call.reject("endpointIds and payload are required"); return
        }
        // NearbyConnections mutates its payload bookkeeping on the main queue.
        // Calling send from Capacitor's bridge queue can race its progress
        // callbacks and corrupt that dictionary, terminating the app.
        DispatchQueue.main.async { [weak self] in
            guard let self, let manager = self.manager else {
                call.reject("Nearby connection is not active")
                return
            }
            guard endpointIDs.allSatisfy(self.connectedEndpoints.contains) else {
                call.reject("Nearby endpoint is disconnected")
                return
            }
            _ = manager.send(Data(payload.utf8), to: endpointIDs, id: .unique())
            call.resolve()
        }
    }

    @objc public func disconnect(_ call: CAPPluginCall) {
        guard let endpointID = call.getString("endpointId") else { call.resolve(); return }
        DispatchQueue.main.async { [weak self] in
            guard let manager = self?.manager else { call.resolve(); return }
            manager.disconnect(from: endpointID) { error in
                DispatchQueue.main.async {
                    if let error { call.reject(error.localizedDescription) }
                    else { call.resolve() }
                }
            }
        }
    }

    @objc public func stop(_ call: CAPPluginCall) {
        stopNearbySession { call.resolve() }
    }

    private func stopNearbySession(completion: (() -> Void)? = nil) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.stopNearbySession(completion: completion) }
            return
        }
        if let completion { stopCompletions.append(completion) }
        if isStopping { return }
        isStopping = true
        isAdvertising = false
        isDiscovering = false
        let group = DispatchGroup()
        if let advertiser {
            group.enter()
            advertiser.stopAdvertising { _ in group.leave() }
        }
        if let discoverer {
            group.enter()
            discoverer.stopDiscovery { _ in group.leave() }
        }
        if let manager {
            for endpointID in connectedEndpoints {
                group.enter()
                manager.disconnect(from: endpointID) { _ in group.leave() }
            }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.connectedEndpoints.removeAll()
            self.advertiser = nil
            self.discoverer = nil
            UIApplication.shared.isIdleTimerDisabled = false
            self.isStopping = false
            let completions = self.stopCompletions
            self.stopCompletions.removeAll()
            completions.forEach { $0() }
        }
    }

    private func endpoint(_ id: EndpointID) -> [String: Any] {
        ["endpointId": id, "name": endpointNames[id] ?? "Nearby player"]
    }

}

extension NearbyConnectionsPlugin: DiscovererDelegate {
    public func discoverer(_ discoverer: Discoverer, didFind endpointID: EndpointID, with context: Data) {
        endpointNames[endpointID] = String(data: context, encoding: .utf8) ?? "Nearby game"
        notifyListeners("endpointFound", data: endpoint(endpointID))
    }
    public func discoverer(_ discoverer: Discoverer, didLose endpointID: EndpointID) {
        notifyListeners("endpointLost", data: endpoint(endpointID))
    }
}

extension NearbyConnectionsPlugin: AdvertiserDelegate {
    public func advertiser(_ advertiser: Advertiser, didReceiveConnectionRequestFrom endpointID: EndpointID, with context: Data, connectionRequestHandler: @escaping (Bool) -> Void) {
        endpointNames[endpointID] = String(data: context, encoding: .utf8) ?? "Nearby player"
        connectionRequestHandler(true)
    }
}

extension NearbyConnectionsPlugin: ConnectionManagerDelegate {
    public func connectionManager(_ connectionManager: ConnectionManager, didReceive verificationCode: String, from endpointID: EndpointID, verificationHandler: @escaping (Bool) -> Void) {
        verifications[endpointID] = verificationHandler
        var data = endpoint(endpointID)
        data["code"] = verificationCode
        notifyListeners("verificationRequired", data: data)
    }

    public func connectionManager(_ connectionManager: ConnectionManager, didReceive data: Data, withID payloadID: PayloadID, from endpointID: EndpointID) {
        guard let payload = String(data: data, encoding: .utf8) else { return }
        var value = endpoint(endpointID)
        value["payload"] = payload
        notifyListeners("payloadReceived", data: value)
    }

    public func connectionManager(_ connectionManager: ConnectionManager, didReceive stream: InputStream, withID payloadID: PayloadID, from endpointID: EndpointID, cancellationToken token: CancellationToken) {}
    public func connectionManager(_ connectionManager: ConnectionManager, didStartReceivingResourceWithID payloadID: PayloadID, from endpointID: EndpointID, at localURL: URL, withName name: String, cancellationToken token: CancellationToken) {}
    public func connectionManager(_ connectionManager: ConnectionManager, didReceiveTransferUpdate update: TransferUpdate, from endpointID: EndpointID, forPayload payloadID: PayloadID) {}

    public func connectionManager(_ connectionManager: ConnectionManager, didChangeTo state: ConnectionState, for endpointID: EndpointID) {
        switch state {
        case .connected:
            connectedEndpoints.insert(endpointID)
            notifyListeners("connected", data: endpoint(endpointID))
        case .disconnected, .rejected:
            connectedEndpoints.remove(endpointID)
            notifyListeners("disconnected", data: endpoint(endpointID))
        case .connecting: break
        }
    }
}
