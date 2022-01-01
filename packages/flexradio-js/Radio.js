
const net = require('net');
const udp = require('dgram');
const EventEmitter = require('events');

const flex = require('flexradio-js');

const log_info = function(msg) { console.log(msg); };
const log_debug = function(msg) { console.log(msg); };
const log_debug_realtime = function(msg) {  };

const CLIENT_SETUP_COMMAND_DELAY = 0;

const ConnectionStates = {
	disconnected: 'disconnected',
	connecting: 'connecting',
	connected: 'connected',
	listening: 'listening'
};

// These are the message types generated by the parser
// or UDP datastream and emitted from a Radio object
const MessageTypes = {
	connection: 'connection',
	error: 'error',
	version: 'version',
	handle: 'handle',
	message: 'message',
	status: 'status',
	response: 'response',
	meter: 'meter',
	panadapter: 'panadapter',
	waterfall: 'waterfall',
	opus: 'opus',
	daxReducedBw: 'daxReducedBw',
	daxIq24: 'daxIq24',
	daxIq48: 'daxIq48',
	daxIq96: 'daxIq96',
	daxIq192: 'daxIq192',
	daxAudio: 'daxAudio',
	discovery: 'discovery',
	unknown: 'unknown'
};

// Unique ID for use in debugging connections, events, etc.
let radio_id = 1;

class Radio extends EventEmitter {
	constructor(descriptor) {
		super();

		// Assign this object a unique ID that will show in debug messages
		// Makes for easy assocaition of events, etc..
		this.radio_id = radio_id++;
		log_info(`Radio[${this.radio_id}].constructor(${descriptor.ip}:${descriptor.port})`);

		// copy descriptor into this object
		for (const [key, value] of Object.entries(descriptor)) {
			this[key] = value;
		}

		if (!this.host && this.ip) {
			// If there is no configured hostname, use ip
			this.host = this.ip;
		}

		this.connectionState = ConnectionStates.disconnected;
		this.connection = null;

		this.realtimeListenerPort = this.port;
		this.realtimeListenerState = ConnectionStates.disconnected;
		this.realtimeListener = null;

		this.streamBuffer = '';

		this.nextRequestSequenceNumber = 1;
		this.requests = {};

		this.client_handle = null;
		this.meters = {};
		this.streams = {};
	}

	static fromDiscoveryDescriptor(radio_descriptor) {
		return new Radio(radio_descriptor);
	}

	connect() {
		log_info(`Radio[${this.radio_id}].connect(${this.host}:${this.port})`);
		this._connectToRadio();
	}

	send(request, callback) {
		// log_debug('Radio.send(' + request + ')');
		if (!request) {
			log_info(`Radio[${this.radio_id}].send() -- Sent empty command. Ignoring.`);
			return;
		}

		this._sendRequest(request, callback);
	}

	disconnect() {
		log_info(`Radio[${this.radio_id}].disconnect()`);
		this._disconnectFromRadio();
	}

	// Connect to radio and setup handlers for TCP/IP data and state changes.
	_connectToRadio() {
		log_info(`Radio[${this.radio_id}]._connectToRadio():`);
		if (this.connectionState === ConnectionStates.disconnected) {
			this._setConnectionState(ConnectionStates.connecting);

			const radio = this;
			this.connection = net.connect(radio.port, radio.host, function() {
				log_info(`Radio[${radio.radio_id}].connection.on('connect')`);

				Promise.all([radio._startRealtimeListener(), 
								radio._getMeterList(),
								// triggers new format UDP packets
								radio.send('client set enforce_network_mtu=1'),
								// triggers new API
								radio.send('client set send_reduced_bw_dax=0')
							])
					.then(function() {
						radio._setConnectionState(ConnectionStates.connected);
					});
			});

			this.connection.on('data', function(data) {
				radio._receiveData(data);
			});

			this.connection.on('error', function(error) {
				// Called when there is an error on the channel
				// MUST be handled by a listener somewhere or will
				// CRASH the program with an unhandled exception.
				console.error(`Radio[${radio.radio_id}].connection.on('error')`);
				try {
					radio.emit(MessageTypes.error, error);
				} catch (err) {
					console.log(err);	
				}
			});

			this.connection.on('close', function() {
				log_info(`Radio[${radio.radio_id}].connection.on('close')`);
				radio._stopRealtimeListener();
				radio._setConnectionState(ConnectionStates.disconnected);
			});
		}
	}

	_disconnectFromRadio() {
		log_info(`Radio[${this.radio_id}]._disconnectFromRadio()`);
		if (this.connectionState !== ConnectionStates.disconnected) {
			this.connection.destroy();
		}
	}

	_startRealtimeListener() {
		const radio = this;
		return new Promise(function(resolve, reject) {
			log_info(`Radio[${radio.radio_id}]._startRealtimeListener():`);
			if (radio.realtimeListenerState === ConnectionStates.disconnected) {
				radio.realtimeListener = udp.createSocket({ type: 'udp4', reuseAddr: false });

				const realtimeListener = radio.realtimeListener;
				realtimeListener.on('listening', function() {
					log_info(`Radio[${radio.radio_id}].realtimeListener.on('listening')`);

					const listenAddress = realtimeListener.address();
					radio.realtimeListenerPort = listenAddress.port;

					log_info(`Radio[${radio.radio_id}].realtimeListener listening on udp4: ${radio.realtimeListenerPort}`);
					radio._setRealtimeListenerState(ConnectionStates.listening);

					radio.send('client udpport ' + radio.realtimeListenerPort, function(response) {
						resolve();
					});
				});

				realtimeListener.on('error', function(error) {
					// MUST be handled by a listener somewhere or will
					// CRASH the program with an unhandled exception.
					console.error(`Radio[${radio.radio_id}].realtimeListener.on('error')`);
					radio.emit(MessageTypes.error, error);
				});

				realtimeListener.on('message', function(data, info) {
					radio._receiveRealtimeData(data, info);
				});

				realtimeListener.on('close', function() {
					log_info(`Radio[${radio.radio_id}].realtimeListener.on('close')`);
					radio._setRealtimeListenerState(ConnectionStates.disconnected);
				});

				radio._setRealtimeListenerState(ConnectionStates.connecting);
				realtimeListener.bind();
			} else {
				resolve();
			}
		});
	}

	_stopRealtimeListener() {
		log_info(`Radio[${this.radio_id}]._stopRealtimeListener()`);
		if (this.realtimeListenerState !== ConnectionStates.disconnected) {
			this.realtimeListener.close();
		}
	}

	_sendRequest(request, callback) {
		const sequenceNumber = this.nextRequestSequenceNumber++;
		this.requests[sequenceNumber] = {
			sequence_number: sequenceNumber,
			request: request,
			callback: callback
		};

		const encoded_request = flex.encode_request(sequenceNumber, request);
		log_debug(`Radio[${this.radio_id}]._sendRequest(${encoded_request})`);
		this.connection.write(encoded_request + '\n');
	}

	// Receives a "chunk" of data on the TCP/IP stream
	// Accumulates it and passes off individual lines to be handled
	_receiveData(raw_data) {
		// log_debug('Radio._receiveData(raw_data):');
		this.streamBuffer += raw_data.toString('utf8');

		let idx;
		while ((idx = this.streamBuffer.indexOf('\n')) >= 0) {
			const response = this.streamBuffer.substring(0, idx);
			this.streamBuffer = this.streamBuffer.substring(idx + 1);

			this._receiveMessage(response);
		}
	}

	// Handles a singluar, separated, message line from TCP/IP stream
	_receiveMessage(encoded_message) {
		log_debug(`Radio[${this.radio_id}]._receiveMessage(${encoded_message})`);
		const message = flex.decode(encoded_message);
		if (message) {
			// Update internal data whenever we see an update...
			switch (message.type) {
				case 'meter':
					// TODO: Rewrite topic and payload to 'meter/24' or 'meter/NAME'?
					this._updateMeterList(message.payload);
					break;
				case 'handle':
					this._updateClientHandle(message.payload);
					break;
			}

			// Send back to a reuqest or emit as asynchronous event
			if (message.type === MessageTypes.response) {
				const request = this.requests[message.sequence_number];
				if (request && request.callback) {
					request.callback(message);
				} else if (!request) {
					console.error(`Radio[${this.radio_id}]._receiveMessage(${encoded_message}): No matching request!`);
				}
				// Remove request after satisfied
				delete this.requests[message.sequence_number];
			} else {
				this.emit(message.type, message);
			}
		}
	}

	_receiveRealtimeData(data) {
		const flex_dgram = flex.decode_realtime(data);
		log_debug_realtime(`Radio[${this.radio_id}]._receiveRealtimeData(${flex_dgram.type})`);
		if (flex_dgram) {
			// Handle any special processing of particular message types
			switch (flex_dgram.type) {
				case MessageTypes.meter:
					this._scaleMeterValues(flex_dgram.payload);
					break;

				case MessageTypes.panadapter:
					// console.log(flex_dgram);
					flex_dgram.payload = this._collectPanadapterFrame(flex_dgram.stream, flex_dgram.payload);
					break;

				default:
			}

			if (flex_dgram.payload) {
				this.emit(flex_dgram.type, flex_dgram);
			}
		}
	}

	_collectPanadapterFrame(stream_id, segment) {
		let stream = this.streams[stream_id];
		if (!stream|| stream.frame_index !== segment.frame_index) {
			stream = {
				'frame_index': segment.frame_index,
				'bins': segment.number_of_bins,
				'bin_size': segment.bin_size,
				'data': Array(segment.total_bins).fill(0)
			};
		} else {
			stream.bins += segment.number_of_bins;
		}

		stream.data.splice(segment.start_bin, segment.number_of_bins, ...segment.data);
		
		if (stream.bins === segment.total_bins) {
			this.streams[stream_id] = null;	
			return stream;
		} 

		this.streams[stream_id] = stream;
		return null;
	}

	_scaleMeterValues(meter_update_msg) {
		const meters = this.meters;
		for (const [meter_num, meter_value] of Object.entries(meter_update_msg)) {
			if (meter_num in meters) {
				const meter = meters[meter_num];
				meter.value = this._scaleMeterValue(meter, meter_value);
				meter_update_msg[meter_num] = meter;
			} else {
				log_info(`Radio._scaleMeterValues(${meter_num}) unknown meter`);
				const meter = {					
					value: meter_value
				};
				meter_update_msg[meter_num] = meter;
			}
		}
	}

	// Divisor values from:
	// https://github.com/K3TZR/xLib6000/blob/master/Sources/xLib6000/Models/Dynamic/Meter.swift
	_scaleMeterValue(meter, value) {
		if ('unit' in meter) {
			const units = meter.unit.toLowerCase();
			switch (units) {
				case 'db':
				case 'dbm':
				case 'dbfs':
				case 'swr':
					// Converted to VitaDB value ( converted_value = ((int32)(MeterValue * 128) & 0xFFFF) )
					value = (value << 16) >> 16; // convert uint16 to int16
					value /= 128.0;
					return Math.round((value + Number.EPSILON) * 100) / 100;

				case 'volts':
				case 'amps':
					// Converted to floating point value ( converted_value = (float) ( MeterValue * 256.0)
					value /= 256.0;
					return Math.round((value + Number.EPSILON) * 100) / 100;

				case 'degc':
				case 'degf':
					//  Converted to floating point value ( converted_value = (float) ( MeterValue * 64.0) )
					value = (value << 16) >> 16; // convert uint16 to int16
					value /= 64.0;
					return Math.round((value + Number.EPSILON) * 100) / 100;

				case 'rpm':
				case 'watts':
				case 'percent':
					return Math.round((value + Number.EPSILON) * 100) / 100;
			}
		}

		return value;
	}

	getConnectionState() {
		return this.connectionState;
	}

	getMeters() {
		return this.meters;
	}

	_setConnectionState(state) {
		this.connectionState = state;
		this.emit(state, 'tcp');
	}

	_setRealtimeListenerState(state) {
		this.realtimeListenerState = state;
		this.emit(state, 'udp');
	}

	_updateClientHandle(handle) {
		const radio = this;
		radio.client_handle = handle;
	}

	_updateMeterList(meters) {
		const radio = this;
		radio.meters = { ...radio.meters, ...meters };
	}

	_getMeterList() {
		const radio = this;
		return new Promise(function(resolve, reject) {
			radio.send('meter list', function(response) {
				radio._updateMeterList(response.payload);
				resolve();
			});
		});
	}
}

module.exports = {
	Radio: Radio,
	RadioConnectionStates: ConnectionStates
};
