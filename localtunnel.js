const lt = require('localtunnel')

module.exports = function (RED) {
  const WHITELISTED_OPTIONS = [
    'port',
    'subdomain',
    'host',
    'local_host',
    'local_https',
    'local_cert',
    'local_key',
    'local_ca',
    'allow_invalid_cert',
  ]

  function clean_options(obj) {
    return WHITELISTED_OPTIONS.reduce((s, key) => {
      if (obj[key] === null || obj[key] === undefined || obj[key] === '') return s

      return {
        ...s,
        [key]: obj[key],
      }
    }, {})
  }

  function LocaltunnelNode(config) {
    RED.nodes.createNode(this, config)

    let node = this
    node.retries = 0

    function close() {
      node.tunnel = null
      node.status({
        fill: 'red',
        shape: 'ring',
        text: 'node-red:common.status.disconnected',
      })
    }

    function closeTunnel() {
      if (node.tunnel) {
        node.tunnel.close()
      } else {
        close()
      }
    }

    function error(e) {
      node.log(RED._('localtunnel.status.error', e))
      node.status({
        fill: 'red',
        shape: 'ring',
        text: e.message,
      })
    }

    function errorRetry(e) {
      if (!node.hasError) {
        node.hasError = e.message
        if (node.retries < node.retry_on_error) {
          ++node.retries
          setTimeout(() => init({ payload: true }), 3000)
        } else {
          error(e)
        }
      } else if (node.hasError !== e.message) {
        node.hasError = e.message
        error(e)
      }
    }

    function request({ method, path }) {
      console.log('REQUEST', method, path)
    }

    ;[
      'inputs',
      'reject_other_subdomain',
      'start_on_load',
      'retry_on_error',
      'bootState',
      ...WHITELISTED_OPTIONS,
    ].forEach(key => {
      this[key] = config[key]
    })

    if (!this.port) {
      this.port = RED.settings.uiPort
    }

    function init(msg) {
      closeTunnel()

      if (msg.payload === 'on' || msg.payload === true) {
        node.status({
          fill: 'blue',
          shape: 'dot',
          text: 'node-red:common.status.connecting',
        })
        ;(async function (node) {
          try {
            node.hasError = null
            node.tunnel = await lt(clean_options(node))
            node.tunnel.on('request', request)
            node.tunnel.on('error', errorRetry)
            node.tunnel.on('close', close)

            let uri = new URL(node.tunnel.url)

            msg.payload = node.tunnel.url
            node.log(RED._('localtunnel.status.connected', { url: msg.payload }))

            if (node.subdomain && node.subdomain !== uri.hostname.slice(0, node.subdomain.length)) {
              if (node.reject_other_subdomain) {
                node.log(
                  RED._('localtunnel.status.unexpected-subdomain', {
                    expected: node.subdomain,
                    actual: uri.hostname.slice(0, node.subdomain.length),
                  })
                )
                msg.payload = null
                closeTunnel()
              } else {
                node.retries = 0

                node.status({
                  fill: 'yellow',
                  shape: 'dot',
                  text: msg.payload,
                })
              }
            } else {
              node.retries = 0

              node.status({
                fill: 'green',
                shape: 'dot',
                text: msg.payload,
              })
            }

            node.send(msg)
          } catch (e) {
            error(e)

            msg.payload = null
            node.error(e.message, msg)

            msg.error = e
            node.send(msg)
          }
        })(node)
      } else {
        node.log(RED._('localtunnel.status.disconnected', { subdomain: node.subdomain }))
        msg.payload = null
        node.send(msg)
      }
    }

    node.on('close', closeTunnel)
    node.on('input', init)

    if (node.start_on_load) {
      setTimeout(() => {
        init({ payload: true })
      }, 1000)
    }
  }

  RED.nodes.registerType('localtunnel', LocaltunnelNode)

  RED.httpAdmin.post(
    '/localtunnel/inject/:id',
    RED.auth.needsPermission('inject.write'),
    (req, res) => {
      let node = RED.nodes.getNode(req.params.id)
      if (node) {
        try {
          node.receive({
            payload: req.body.on === 'true',
          })
          res.sendStatus(200)
        } catch (err) {
          res.sendStatus(500)
          node.error(RED._('node-red:inject.failed', { error: err.toString() }))
        }
      } else {
        res.sendStatus(404)
      }
    }
  )
}
