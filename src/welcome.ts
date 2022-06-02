import figlet from 'figlet'

export default (): Promise<void> => {
  return new Promise((resolve) => {
    figlet('CLI For OLKJ', (err, data) => {
      console.log(`\n ${data} \n`)
      console.log('')
      resolve()
    })
  })
}
