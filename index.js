#!/usr/bin/env node
"use strict"

const rp = require('request-promise')
const chalk = require("chalk")
const rainbow = require("chalk-rainbow")
const twilio = require("twilio")
const blessed = require("blessed")
const contrib = require("blessed-contrib")
const format = require("date-format")
const pretty = require("pretty-ms")
const airports = require("airports")

// API constants
const ryanairUrl = 'https://desktopapps.ryanair.com/en-ie/availability'

// Time constants
const TIME_MS = 1
const TIME_SEC = TIME_MS * 1000
const TIME_MIN = TIME_SEC * 60
const TIME_HOUR = TIME_MIN * 60

// Fares
var prevLowestOutboundFare
var prevLowestReturnFare
const fares = {
  outbound: [],
  return: []
}

//parse arguments
var argv = require("yargs")
  .version('0.0.1')
  .usage('Usage: $0 --from <IATA Code> --to <IATA Code> --leave-date <yyyy-mm-dd> -- return-date <yyyy-mm-dd> --passengers <n> --individual-deal-price <n> --total-deal-price <n> --interval <n>')
  .describe('from', 'Departure Airport')
  .describe('to', 'Destination Airport')
  .describe('leave-date', 'Departure Date')
  .describe('return-date', 'Return Date')
  .describe('passengers', 'Number Of Passengers')
  .describe('individual-deal-price', 'Desired Price Per Passenger')
  .describe('total-deal-price', 'Desired Total Price')
  .describe('interval', 'API Polling Interval')
  .describe('one-way', 'One way trip?')
  .demandOption(['from', 'to', 'leave-date', 'passengers'])
  .default('interval', 30)
  .argv

// Map arguments
var originAirport = argv.from
var destinationAirport = argv.to
var outboundDateString = argv.leaveDate
var returnDateString = argv.returnDate
var adultPassengerCount = argv.passengers
var individualDealPrice = argv.individualDealPrice
var totalDealPrice = argv.totalDealPrice
var interval = argv.interval
var oneWay = argv.oneWay

// Check if Twilio env vars are set
const isTwilioConfigured = process.env.TWILIO_ACCOUNT_SID &&
                           process.env.TWILIO_AUTH_TOKEN &&
                           process.env.TWILIO_PHONE_FROM &&
                           process.env.TWILIO_PHONE_TO

/**
 * Dashboard renderer
 */
class Dashboard {

  constructor() {
    this.markers = []
    this.widgets = {}

    // Configure blessed
    this.screen = blessed.screen({
      title: "Ryanair Dashboard",
      autoPadding: true,
      dockBorders: true,
      fullUnicode: true,
      smartCSR: true
    })

    this.screen.key(["escape", "q", "C-c"], (ch, key) => process.exit(0))

    // Grid settings
    this.grid = new contrib.grid({
      screen: this.screen,
      rows: 12,
      cols: 12
    })

    // Graphs
    this.graphs = {
      outbound: {
        title: "Origin/Outbound",
        x: [],
        y: [],
        style: {
          line: "red"
        }
      }
    }

    
    if (!oneWay)
      this.graphs.return = {
        title: "Destination/Return",
        x: [],
        y: [],
        style: {
          line: "yellow"
        }
      }

    // Shared settings
    const shared = {
      border: {
        type: "line"
      },
      style: {
        fg: "blue",
        text: "blue",
        border: {
          fg: "green"
        }
      }
    }

    // Widgets
    const widgets = {
      map: {
        type: contrib.map,
        size: {
          width: 9,
          height: 5,
          top: 0,
          left: 0
        },
        options: Object.assign({}, shared, {
          label: "Map",
          region: "world"
        })
      },
      settings: {
        type: contrib.log,
        size: {
          width: 3,
          height: 5,
          top: 0,
          left: 9
        },
        options: Object.assign({}, shared, {
          label: "Settings",
          padding: {
            left: 1
          }
        })
      },
      graph: {
        type: contrib.line,
        size: {
          width: 12,
          height: 4,
          top: 5,
          left: 0
        },
        options: Object.assign({}, shared, {
          label: "Prices",
          showLegend: true,
          legend: {
            width: 20
          }
        })
      },
      log: {
        type: contrib.log,
        size: {
          width: 12,
          height: 3,
          top: 9,
          left: 0
        },
        options: Object.assign({}, shared, {
          label: "Log",
          padding: {
            left: 1
          }
        })
      }
    }

    for (let name in widgets) {
      let widget = widgets[name]

      this.widgets[name] = this.grid.set(
        widget.size.top,
        widget.size.left,
        widget.size.height,
        widget.size.width,
        widget.type,
        widget.options
      )
    }
  }

  /**
   * Render screen
   *
   * @return {Void}
   */
  render() {
    this.screen.render()
  }

  /**
   * Plot graph data
   *
   * @param {Arr} prices
   *
   * @return {Void}
   */
  plot(prices) {
    const now = format("MM/dd/yy-hh:mm:ss", new Date())

    Object.assign(this.graphs.outbound, {
      x: [...this.graphs.outbound.x, now],
      y: [...this.graphs.outbound.y, prices.outbound]
    })

    if (!oneWay){
      Object.assign(this.graphs.return, {
        x: [...this.graphs.return.x, now],
        y: [...this.graphs.return.y, prices.return]
      })
      this.widgets.graph.setData([
        this.graphs.outbound,
        this.graphs.return
      ])
    }
    else{
      this.widgets.graph.setData([
        this.graphs.outbound,
      ])
    }  
  }

  /**
   * Add waypoint marker to map
   *
   * @param {Obj} data
   *
   * @return {Void}
   */
  waypoint(data) {
    this.markers.push(data)

    if (this.blink) {
      return
    }

    // Blink effect
    var visible = true

    this.blink = setInterval(() => {
      if (visible) {
        this.markers.forEach((m) => this.widgets.map.addMarker(m))
      } else {
        this.widgets.map.clearMarkers()
      }

      visible = !visible

      this.render()
    }, 1 * TIME_SEC)
  }

  /**
   * Log data
   *
   * @param {Arr} messages
   *
   * @return {Void}
   */
  log(messages) {
    const now = format("MM/dd/yy-hh:mm:ss", new Date())
    if(typeof messages === 'string') messages = [messages]
    messages.forEach((m) => this.widgets.log.log(`${now}: ${m}`))
  }

  /**
   * Display settings
   *
   * @param {Arr} config
   *
   * @return {Void}
   */
  settings(config) {
    config.forEach((c) => this.widgets.settings.add(c))
  }
}

const dashboard = new Dashboard()

/**
 * Send a text message using Twilio
 *
 * @param {Str} message
 *
 * @return {Void}
 */
const sendTextMessage = (message) => {
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)

    twilioClient.sendMessage({
      from: process.env.TWILIO_PHONE_FROM,
      to: process.env.TWILIO_PHONE_TO,
      body: message
    }, function(err, data) {
      if (!dashboard) return
      if (err) {
        dashboard.log([
          chalk.red(`Error: failed to send SMS to ${process.env.TWILIO_PHONE_TO} from ${process.env.TWILIO_PHONE_FROM}`)
        ])
      } else {
        dashboard.log([
          chalk.green(`Successfully sent SMS to ${process.env.TWILIO_PHONE_TO} from ${process.env.TWILIO_PHONE_FROM}`)
        ])
      }
    })
  } catch(e) {}
}

/**
 * Generate requst object
 *
 * @return {promise}
 */
function generateRequestObject() {
  return new Promise(
    function (resolve) {
        resolve({
          uri: ryanairUrl,
          qs: {
              ADT: adultPassengerCount,
              CHD: 0,
              DateIn: returnDateString,
              DateOut: outboundDateString,
              Destination: destinationAirport,
              Origin: originAirport,
              FlexDaysIn: 0,
              FlexDaysOut: 0,
              INF: 0,
              RoundTrip: !oneWay,
              TEEN: 0,
              exists: false,
              ToUs: 'AGREED'
          },
          json: true // Automatically parses the JSON string in the response
        })
    })
}

/**
 * Fetch latest Southwest prices
 *
 * @return {Void}
 */
const fetch = () => {
  generateRequestObject()
    .then((options) => {
      return rp(options)
    })
    .then((data) => {
      var outPrice = data.trips[0].dates[0].flights[0].regularFare.fares[0].amount
      fares.outbound.push(outPrice)
      if(!oneWay){
        var inPrice = data.trips[1].dates[0].flights[0].regularFare.fares[0].amount
        fares.return.push(inPrice)
      }
    })
    .then(() => {
      const lowestOutboundFare = Math.min(...fares.outbound)
      const lowestReturnFare = oneWay? 0 : Math.min(...fares.return)
      
      var faresAreValid = true

      // Clear previous fares
      fares.outbound = []
      fares.return = []

      // Get difference from previous fares
      const outboundFareDiff = prevLowestOutboundFare - lowestOutboundFare
      const returnFareDiff = oneWay? 0 : (prevLowestReturnFare - lowestReturnFare)
      var outboundFareDiffString = ""
      var returnFareDiffString = ""

      // Create a string to show the difference
      if (!isNaN(outboundFareDiff) && !isNaN(returnFareDiff)) {

        // Usually this is because of a scraping error
        if (!isFinite(outboundFareDiff) || !isFinite(returnFareDiff)) {
          faresAreValid = false
        }

        if (outboundFareDiff > 0) {
          outboundFareDiffString = chalk.green(`(down \€${Math.abs(outboundFareDiff)})`)
        } else if (outboundFareDiff < 0) {
          outboundFareDiffString = chalk.red(`(up \€${Math.abs(outboundFareDiff)})`)
        } else if (outboundFareDiff === 0) {
          outboundFareDiffString = chalk.blue(`(no change)`)
        }

        if (returnFareDiff > 0 && !oneWay) {
          returnFareDiffString = chalk.green(`(down \€${Math.abs(returnFareDiff)})`)
        } else if (returnFareDiff < 0) {
          returnFareDiffString = chalk.red(`(up \€${Math.abs(returnFareDiff)})`)
        } else if (returnFareDiff === 0) {
          returnFareDiffString = chalk.blue(`(no change)`)
        }
      }

      if (faresAreValid) {

        // Store current fares for next time
        prevLowestOutboundFare = lowestOutboundFare
        prevLowestReturnFare = lowestReturnFare

        // Do some Twilio magic (SMS alerts for awesome deals)
        const awesomeDealIsAwesome = (
          totalDealPrice && (lowestOutboundFare + lowestReturnFare <= totalDealPrice)
        ) || (
          individualDealPrice && (lowestOutboundFare <= individualDealPrice || lowestReturnFare <= individualDealPrice)
        )

        if (awesomeDealIsAwesome) {
          const message = `Deal alert! Combined total has hit \€${lowestOutboundFare + lowestReturnFare}. Individual fares are \€${lowestOutboundFare} (outbound) and \€${lowestReturnFare} (return).`

          // Party time
          dashboard.log([
            rainbow(message)
          ])

          if (isTwilioConfigured) {
            sendTextMessage(message)
          }
        }

        if(oneWay){
          dashboard.log([
            `Lowest fares for an outbound flight is currently \€${[lowestOutboundFare, outboundFareDiffString].filter(i => i).join(" ")}`,
          ])
          dashboard.plot({
            outbound: lowestOutboundFare
          })
        }else{
          dashboard.log([
            `Lowest fares for an outbound flight is currently \€${[lowestOutboundFare, outboundFareDiffString].filter(i => i).join(" ")}`,
            `Lowest fares for a return flight is currently \€${[lowestReturnFare, returnFareDiffString].filter(i => i).join(" ")}`
          ])
          dashboard.plot({
            outbound: lowestOutboundFare,
            return: lowestReturnFare
          })
        }
          
      }

      dashboard.render()
      setTimeout(fetch, interval * TIME_MIN)
    })
    .catch((err) => {
      dashboard.log([
        chalk.red(err.toString())
      ])
    })
}

// Get lat/lon for airports (no validation on non-existent airports)
airports.forEach((airport) => {
  switch (airport.iata) {
    case originAirport:
      dashboard.waypoint({ lat: airport.lat, lon: airport.lon, color: "red", char: "X" })
      break
    case destinationAirport:
      dashboard.waypoint({ lat: airport.lat, lon: airport.lon, color: "yellow", char: "X" })
      break
  }
})

// Print settings
dashboard.settings([
  `Origin airport: ${originAirport}`,
  `Destination airport: ${destinationAirport}`,
  `Outbound date: ${outboundDateString}`,
  `Return date: ${oneWay? "---" : returnDateString}`,
  `Passengers: ${adultPassengerCount}`,
  `Interval: ${pretty(interval * TIME_MIN)}`,
  `Individual deal price: ${individualDealPrice ? `<= \€${individualDealPrice}` : "disabled"}`,
  `Total deal price: ${totalDealPrice ? `<= \€${totalDealPrice}` : "disabled"}`,
  `One way trip? ${oneWay}`,
  `SMS alerts: ${isTwilioConfigured ? process.env.TWILIO_PHONE_TO : "disabled"}`
])

fetch()
